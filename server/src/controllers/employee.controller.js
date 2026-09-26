const bcrypt = require('bcryptjs');
const { User } = require('../models');

/**
 * Server-side auth state — no client's business, ANY role. `otp_hash`
 * especially: the reset code is 6 digits hashed at bcrypt cost 10, which
 * brute-forces offline in minutes once leaked — so returning it in a list
 * turned "forgot password" into same-branch account takeover (trigger a
 * reset for a colleague, read the hash off this endpoint, crack, sign in).
 * The rest are the same family: challenges, tokens, counters, credentials.
 */
const AUTH_STATE_FIELDS = '-password_hash -otp_hash -otp_expires_at -otp_attempts'
  + ' -otp_sent_at -otp_window_started_at -otp_sends_in_window'
  + ' -webauthn_credentials -webauthn_challenge -board_token';
// Pay and national-ID: on these User endpoints only an admin reads them.
// (The one client consumer of the list picks a teacher by full_name.)
const PRIVATE_USER_FIELDS = ' -salary -bank_account -bank_branch -bank_number -id_number';
const userSelectFor = (role) =>
  role === 'system_admin' ? AUTH_STATE_FIELDS : AUTH_STATE_FIELDS + PRIVATE_USER_FIELDS;

// The same fields, scrubbed from a doc already in hand (create/update echo
// the saved doc back — same leak, different door).
function stripAuthState(obj) {
  for (const f of AUTH_STATE_FIELDS.split(' ')) delete obj[f.slice(1)];
  return obj;
}

async function getAll(req, res, next) {
  try {
    const { branch } = req.query;
    const filter = { is_active: true };

    // Non-admins can only see their own branch.
    // For admin: 'all' (cross-branch view) is a UI sentinel — skip the filter.
    if (req.user.role !== 'system_admin') {
      filter.branch_id = req.user.branch_id;
    } else if (branch && branch !== 'all') {
      filter.branch_id = branch;
    }

    const employees = await User.find(filter)
      .select(userSelectFor(req.user.role))
      .populate('branch_id', 'name')
      .sort({ full_name: 1 })
      .lean();

    res.json({
      employees: employees.map(e => ({
        ...e, id: e._id,
        branch_name: e.branch_id?.name || null,
        branch_id: e.branch_id?._id || e.branch_id,
      })),
    });
  } catch (error) { next(error); }
}

async function getById(req, res, next) {
  try {
    const employee = await User.findById(req.params.id)
      .select(userSelectFor(req.user.role))
      .populate('branch_id', 'name')
      .lean();

    if (!employee) return res.status(404).json({ error: 'עובד לא נמצא' });

    // Non-admins can only view own branch employees
    if (req.user.role !== 'system_admin' &&
        String(employee.branch_id?._id || employee.branch_id) !== String(req.user.branch_id)) {
      return res.status(403).json({ error: 'אין הרשאה' });
    }

    res.json({
      employee: {
        ...employee, id: employee._id,
        branch_name: employee.branch_id?.name || null,
      },
    });
  } catch (error) { next(error); }
}

async function create(req, res, next) {
  try {
    const {
      email, password, full_name, role, branch_id,
      phone, id_number, address, position, salary,
      bank_account, bank_branch, bank_number, start_date,
    } = req.body;

    if (!email || !password || !full_name) {
      return res.status(400).json({ error: 'אימייל, סיסמה ושם מלא חובה' });
    }

    const existing = await User.findOne({ email: email.toLowerCase().trim() });
    if (existing) {
      return res.status(409).json({ error: 'אימייל כבר קיים במערכת' });
    }

    // Only system_admin can create system_admin or branch_manager
    const allowedRole = req.user.role === 'system_admin' ? role : 'employee';
    const effectiveBranch = req.user.role === 'system_admin' ? branch_id : req.user.branch_id;

    const hash = await bcrypt.hash(password, 10);

    const employee = await User.create({
      email: email.toLowerCase().trim(),
      password_hash: hash,
      full_name,
      role: allowedRole || 'employee',
      branch_id: effectiveBranch || null,
      phone: phone || '',
      id_number: id_number || '',
      address: address || '',
      position: position || '',
      salary: salary || 0,
      bank_account: bank_account || '',
      bank_branch: bank_branch || '',
      bank_number: bank_number || '',
      start_date: start_date || null,
    });

    const result = stripAuthState(employee.toObject());

    res.status(201).json({ employee: { ...result, id: result._id } });
  } catch (error) { next(error); }
}

async function update(req, res, next) {
  try {
    const employee = await User.findById(req.params.id);
    if (!employee) return res.status(404).json({ error: 'עובד לא נמצא' });

    // Permission check
    if (req.user.role !== 'system_admin' &&
        String(employee.branch_id) !== String(req.user.branch_id)) {
      return res.status(403).json({ error: 'אין הרשאה' });
    }
    // A same-branch manager must not edit an admin's or accountant's login
    // record at all. Admins are commonly filed under a branch, and this used
    // to make their record editable — including its password — by whoever
    // managed that branch. Editing UP the privilege ladder is never a branch
    // matter.
    if (req.user.role !== 'system_admin' &&
        ['system_admin', 'accountant'].includes(employee.role)) {
      return res.status(403).json({ error: 'אין הרשאה' });
    }

    const fields = ['full_name', 'phone', 'address', 'position',
      'bank_account', 'bank_branch', 'bank_number', 'start_date'];

    // Identity, placement, role and salary are admin decisions: id_number is
    // how punches and payslips find a person, branch_id is what every scope
    // check clamps to — letting a branch manager rewrite either is an escape
    // hatch from both.
    if (req.user.role === 'system_admin') {
      fields.push('role', 'salary', 'id_number', 'branch_id');
    }

    fields.forEach(f => {
      if (req.body[f] !== undefined) employee[f] = req.body[f];
    });

    // Password change — system_admin only. Setting someone else's password IS
    // becoming them on the next login; a same-branch manager could do this to
    // any colleague (and, before the role guard above, to an admin). Self-
    // service password changes live in the auth flows, not here.
    if (req.body.password) {
      if (req.user.role !== 'system_admin') {
        return res.status(403).json({ error: 'שינוי סיסמה מותר למנהל מערכת בלבד' });
      }
      employee.password_hash = await bcrypt.hash(req.body.password, 10);
    }

    await employee.save();

    const result = stripAuthState(employee.toObject());
    res.json({ employee: { ...result, id: result._id } });
  } catch (error) { next(error); }
}

async function remove(req, res, next) {
  try {
    const employee = await User.findById(req.params.id);
    if (!employee) return res.status(404).json({ error: 'עובד לא נמצא' });

    employee.is_active = false;
    await employee.save();
    res.json({ message: 'עובד הוסר', id: req.params.id });
  } catch (error) { next(error); }
}

module.exports = { getAll, getById, create, update, remove };
