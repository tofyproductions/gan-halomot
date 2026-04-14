const bcrypt = require('bcryptjs');
const { User } = require('../models');

async function getAll(req, res, next) {
  try {
    const { branch } = req.query;
    const filter = { is_active: true };

    // Non-admins can only see their own branch
    if (req.user.role !== 'system_admin') {
      filter.branch_id = req.user.branch_id;
    } else if (branch) {
      filter.branch_id = branch;
    }

    const employees = await User.find(filter)
      .select('-password_hash')
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
      .select('-password_hash')
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

    const result = employee.toObject();
    delete result.password_hash;

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

    const fields = ['full_name', 'phone', 'id_number', 'address', 'position',
      'bank_account', 'bank_branch', 'bank_number', 'start_date', 'branch_id'];

    // Only system_admin can change role and salary directly
    if (req.user.role === 'system_admin') {
      fields.push('role', 'salary');
    }

    fields.forEach(f => {
      if (req.body[f] !== undefined) employee[f] = req.body[f];
    });

    // Password change
    if (req.body.password) {
      employee.password_hash = await bcrypt.hash(req.body.password, 10);
    }

    await employee.save();

    const result = employee.toObject();
    delete result.password_hash;
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
