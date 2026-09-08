const bcrypt = require('bcryptjs');
const { User, Setting, Employee, CustomRole } = require('../models');
const { ROLES } = require('../constants/roles');
const { ALL_TAB_IDS, defaultTabsForRole } = require('../constants/tabs');

/**
 * GET /api/admin/role-tabs
 * Tab overrides that apply to EVERY user of a role, so an admin can grant/revoke
 * a tab for a whole role in one action instead of user-by-user.
 * Shape: { [role]: { add: [tabId], remove: [tabId] } }
 */
async function getRoleTabs(req, res, next) {
  try {
    const doc = await Setting.findOne({ key: 'role_tab_overrides' }).lean();
    res.json({ role_tabs: doc?.value || {} });
  } catch (err) { next(err); }
}

/** PUT /api/admin/role-tabs  body: { [role]: { add: [], remove: [] } } */
async function setRoleTabs(req, res, next) {
  try {
    const body = req.body?.role_tabs || {};
    const clean = {};
    for (const role of ROLES) {
      const entry = body[role];
      if (!entry) continue;
      const norm = (arr) => [...new Set((Array.isArray(arr) ? arr : [])
        .filter(t => typeof t === 'string' && t.length > 0 && t.length < 64))];
      clean[role] = { add: norm(entry.add), remove: norm(entry.remove) };
    }
    await Setting.findOneAndUpdate({ key: 'role_tab_overrides' }, { value: clean }, { upsert: true });
    res.json({ ok: true, role_tabs: clean });
  } catch (err) { next(err); }
}

async function listUsers(req, res, next) {
  try {
    const found = await User.find({ is_active: true })
      .select('full_name email role custom_role_id branch_id managed_branch_ids position tab_overrides_add tab_overrides_remove')
      .populate('branch_id', 'name')
      .populate('managed_branch_ids', 'name')
      .populate('custom_role_id', 'name base_role')
      .sort({ full_name: 1 });

    // The permissions screen shows the custom role's NAME on the role chip and
    // computes the per-user diff against the custom role's lists, so it needs
    // the name and the base beside the id — and it needs the id as a plain
    // string, not as a populated object it would then have to unwrap
    // everywhere it compares.
    const users = found.map((u) => {
      const o = u.toObject();
      o.custom_role_name = o.custom_role_id?.name || null;
      o.custom_role_base_role = o.custom_role_id?.base_role || null;
      o.custom_role_id = o.custom_role_id?._id ? String(o.custom_role_id._id) : null;
      return o;
    });

    // Active staff who have no login at all. They cannot appear in this table
    // (it lists Users), so without calling them out the page silently pretends
    // they don't exist — which is how a branch manager can be set up in the
    // employee card and never show up here.
    const unlinked = (await Employee.find({ is_active: true, $or: [{ user_id: null }, { user_id: { $exists: false } }] })
      .select('full_name position israeli_id branch_id')
      .populate('branch_id', 'name')
      .sort({ full_name: 1 })
      .lean())
      .map(e => ({
        id: String(e._id),
        full_name: e.full_name,
        position: e.position || '',
        branch_name: e.branch_id?.name || '',
        // No ת"ז means we can't mint a login for her — it's the account key.
        has_israeli_id: String(e.israeli_id || '').replace(/\D/g, '').length >= 7,
      }));

    res.json({ users, unlinked_employees: unlinked });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/admin/users/:id/role — role, managed branches, custom role.
 *
 * `role` and `custom_role_id` are not two independent fields. A custom role
 * holder's `role` is her custom role's `base_role` IN THE DATABASE, because
 * that single field is what every branch-scope rule and every requireRole in
 * the codebase reads. So assigning a custom role writes the base role too, and
 * moving somebody to a built-in role that is not that base takes the custom
 * role off her — otherwise she would keep a tab layer belonging to a role she
 * no longer has.
 */
async function updateUserRole(req, res, next) {
  try {
    const { id } = req.params;
    const { role, managed_branch_ids } = req.body;
    const setObj = {};
    const customGiven = Object.prototype.hasOwnProperty.call(req.body || {}, 'custom_role_id');
    const customId = req.body?.custom_role_id;

    if (role && !ROLES.includes(role)) return res.status(400).json({ error: 'role not allowed' });

    if (customGiven && customId) {
      const cr = await CustomRole.findById(customId).lean().catch(() => null);
      if (!cr) return res.status(404).json({ error: 'תפקיד מותאם לא נמצא' });
      setObj.custom_role_id = cr._id;
      setObj.role = cr.base_role;      // the single field everything else reads
    } else if (customGiven) {
      setObj.custom_role_id = null;
      if (role) setObj.role = role;
    } else if (role) {
      setObj.role = role;
      // `role` alone, on somebody who holds a custom role: keep the custom role
      // only while it still describes this role.
      const current = await User.findById(id).select('custom_role_id')
        .populate('custom_role_id', 'base_role');
      if (current?.custom_role_id && current.custom_role_id.base_role !== role) {
        setObj.custom_role_id = null;
      }
    }

    if (Array.isArray(managed_branch_ids)) {
      setObj.managed_branch_ids = managed_branch_ids.filter(x => x && typeof x === 'string');
    }
    const updated = await User.findByIdAndUpdate(id, setObj, { new: true })
      .select('full_name email role custom_role_id branch_id managed_branch_ids tab_overrides_add tab_overrides_remove')
      .populate('branch_id', 'name')
      .populate('managed_branch_ids', 'name')
      .populate('custom_role_id', 'name base_role');
    if (!updated) return res.status(404).json({ error: 'משתמש לא נמצא' });
    res.json({ user: shapeUser(updated) });
  } catch (err) { next(err); }
}

/** The row shape the permissions screen expects — see listUsers. */
function shapeUser(doc) {
  const o = doc.toObject ? doc.toObject() : { ...doc };
  o.custom_role_name = o.custom_role_id?.name || null;
  o.custom_role_base_role = o.custom_role_id?.base_role || null;
  o.custom_role_id = o.custom_role_id?._id ? String(o.custom_role_id._id) : null;
  return o;
}

/* ------------------------------------------------------------------ *
 *  Custom roles — a named permission set, built from one person's tabs.
 *
 *  See models/CustomRole.js for what one IS. These four endpoints are the
 *  whole of its administration: list them, mint one from somebody, edit it,
 *  delete it.
 * ------------------------------------------------------------------ */

const cleanTabList = (arr) => [...new Set((Array.isArray(arr) ? arr : [])
  .filter(t => typeof t === 'string' && t.length > 0 && t.length < 64))];

/** Role-wide override entry for a role, straight from the Setting document. */
async function roleWideOverride(role) {
  const doc = await Setting.findOne({ key: 'role_tab_overrides' }).lean();
  const entry = (doc?.value || {})[role] || {};
  return {
    add: Array.isArray(entry.add) ? entry.add : [],
    remove: Array.isArray(entry.remove) ? entry.remove : [],
  };
}

/**
 * What this person can actually reach today, tab by tab.
 *
 * Same precedence as middleware/auth.js#tabDecision and
 * client/src/config/tabs.js#hasTabAccess, in the same order — per-user remove,
 * per-user add, role-layer remove, role-layer add, the role default. Three
 * implementations of one rule is two of them being wrong, so this one is
 * written to be read next to those.
 *
 * Ids nobody knows about (a tab removed from the client, a grant typed by
 * hand) are kept rather than dropped: a custom role built from somebody must
 * not quietly take away something she has.
 */
function effectiveTabSet({ baseRole, roleLayer, userAdd, userRemove }) {
  const defaults = defaultTabsForRole(baseRole);
  const known = new Set(ALL_TAB_IDS);
  const extras = [...new Set([
    ...roleLayer.add, ...roleLayer.remove, ...userAdd, ...userRemove,
  ])].filter(t => !known.has(t)).sort();
  const universe = [...ALL_TAB_IDS, ...extras];

  const effective = universe.filter((tabId) => {
    if (userRemove.includes(tabId)) return false;
    if (userAdd.includes(tabId)) return true;
    if (roleLayer.remove.includes(tabId)) return false;
    if (roleLayer.add.includes(tabId)) return true;
    return defaults.includes(tabId);
  });
  return { defaults, effective };
}

/** GET /api/admin/custom-roles */
async function listCustomRoles(req, res, next) {
  try {
    const roles = await CustomRole.find({}).sort({ name: 1 }).lean();
    const counts = await User.aggregate([
      { $match: { custom_role_id: { $ne: null } } },
      { $group: { _id: '$custom_role_id', n: { $sum: 1 } } },
    ]);
    const byId = Object.fromEntries(counts.map(c => [String(c._id), c.n]));
    res.json({
      roles: roles.map(r => ({
        _id: String(r._id),
        name: r.name,
        base_role: r.base_role,
        tab_add: r.tab_add || [],
        tab_remove: r.tab_remove || [],
        user_count: byId[String(r._id)] || 0,
      })),
    });
  } catch (err) { next(err); }
}

/**
 * POST /api/admin/custom-roles/from-user/:userId  body: { name }
 *
 * The whole point of the feature: somebody has been given exactly the right
 * permissions by hand, one checkbox at a time, and the next person hired to do
 * her job should get them without anybody having to remember which boxes.
 *
 * Her effective set is computed here and then EXPRESSED as a difference from
 * the base role's defaults, because that is what the role layer is. And she is
 * assigned the new role at once, with her per-user overrides cleared — they
 * are the role now, and leaving them would make every later edit of the role
 * do nothing for the one person it was built from.
 */
async function createCustomRoleFromUser(req, res, next) {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'שם לתפקיד נדרש' });

    const user = await User.findById(req.params.userId).populate('custom_role_id');
    if (!user) return res.status(404).json({ error: 'משתמש לא נמצא' });

    const existing = await CustomRole.findOne({ name }).lean();
    if (existing) return res.status(409).json({ error: `כבר קיים תפקיד בשם "${name}"` });

    // Somebody who already holds a custom role is measured against THAT role,
    // not against a role-wide override she is not subject to.
    const held = user.custom_role_id;
    const baseRole = held ? held.base_role : user.role;
    const roleLayer = held
      ? { add: held.tab_add || [], remove: held.tab_remove || [] }
      : await roleWideOverride(user.role);

    const { defaults, effective } = effectiveTabSet({
      baseRole,
      roleLayer,
      userAdd: user.tab_overrides_add || [],
      userRemove: user.tab_overrides_remove || [],
    });

    const tab_add = effective.filter(t => !defaults.includes(t));
    const tab_remove = defaults.filter(t => !effective.includes(t));

    let role;
    try {
      role = await CustomRole.create({
        name, base_role: baseRole, tab_add, tab_remove,
        created_from_user_id: user._id,
        created_by: req.user?.id || null,
      });
    } catch (err) {
      if (err?.code === 11000) return res.status(409).json({ error: `כבר קיים תפקיד בשם "${name}"` });
      throw err;
    }

    user.custom_role_id = role._id;
    user.role = baseRole;
    user.tab_overrides_add = [];
    user.tab_overrides_remove = [];
    await user.save();

    const fresh = await User.findById(user._id)
      .select('full_name email role custom_role_id branch_id managed_branch_ids tab_overrides_add tab_overrides_remove')
      .populate('branch_id', 'name')
      .populate('managed_branch_ids', 'name')
      .populate('custom_role_id', 'name base_role');

    res.json({
      role: {
        _id: String(role._id), name: role.name, base_role: role.base_role,
        tab_add: role.tab_add, tab_remove: role.tab_remove, user_count: 1,
      },
      user: shapeUser(fresh),
    });
  } catch (err) { next(err); }
}

/**
 * PATCH /api/admin/custom-roles/:id  body: { name?, tab_add?, tab_remove? }
 *
 * `base_role` is immutable. Changing it would move every holder's `role` — the
 * field the whole codebase authorises on — as a side effect of editing a tab
 * list, which is not a thing an admin can be asked to have meant.
 */
async function updateCustomRole(req, res, next) {
  try {
    const role = await CustomRole.findById(req.params.id);
    if (!role) return res.status(404).json({ error: 'תפקיד לא נמצא' });

    if (req.body?.name !== undefined) {
      const name = String(req.body.name || '').trim();
      if (!name) return res.status(400).json({ error: 'שם לתפקיד נדרש' });
      if (name !== role.name) {
        const clash = await CustomRole.findOne({ name, _id: { $ne: role._id } }).lean();
        if (clash) return res.status(409).json({ error: `כבר קיים תפקיד בשם "${name}"` });
      }
      role.name = name;
    }
    if (req.body?.tab_add !== undefined) role.tab_add = cleanTabList(req.body.tab_add);
    if (req.body?.tab_remove !== undefined) role.tab_remove = cleanTabList(req.body.tab_remove);

    try {
      await role.save();
    } catch (err) {
      if (err?.code === 11000) return res.status(409).json({ error: 'כבר קיים תפקיד בשם הזה' });
      throw err;
    }

    const user_count = await User.countDocuments({ custom_role_id: role._id });
    res.json({
      role: {
        _id: String(role._id), name: role.name, base_role: role.base_role,
        tab_add: role.tab_add, tab_remove: role.tab_remove, user_count,
      },
    });
  } catch (err) { next(err); }
}

/**
 * DELETE /api/admin/custom-roles/:id
 *
 * Holders fall back to the base role they already carry in `role` — they do
 * not lose their login, and they do not silently keep the tab layer of a role
 * that no longer exists.
 */
async function deleteCustomRole(req, res, next) {
  try {
    const role = await CustomRole.findById(req.params.id);
    if (!role) return res.status(404).json({ error: 'תפקיד לא נמצא' });
    const { modifiedCount } = await User.updateMany(
      { custom_role_id: role._id },
      { $set: { custom_role_id: null, role: role.base_role } },
    );
    await CustomRole.deleteOne({ _id: role._id });
    res.json({ ok: true, reverted: modifiedCount || 0 });
  } catch (err) { next(err); }
}

async function updateUserTabs(req, res, next) {
  try {
    const { id } = req.params;
    const { add, remove } = req.body;

    if (!Array.isArray(add) || !Array.isArray(remove)) {
      return res.status(400).json({ error: 'add ו-remove חייבים להיות מערכים' });
    }
    const cleanAdd = [...new Set(add.filter(t => typeof t === 'string' && t.length > 0 && t.length < 64))];
    const cleanRemove = [...new Set(remove.filter(t => typeof t === 'string' && t.length > 0 && t.length < 64))];

    const user = await User.findByIdAndUpdate(
      id,
      { tab_overrides_add: cleanAdd, tab_overrides_remove: cleanRemove },
      { new: true }
    ).select('full_name email role tab_overrides_add tab_overrides_remove');

    if (!user) return res.status(404).json({ error: 'משתמש לא נמצא' });
    res.json({ user });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/admin/users/:id/reset-password
 * Admin resets a user's login password. For security we NEVER reveal or set a
 * plaintext password — we flip password_set back to false so the user can log
 * in with name+ID again and is prompted to choose a new password. Optionally a
 * temporary password can be provided to hand the employee.
 */
/**
 * Issuing a new password for an employee who lost theirs.
 *
 * WHAT THIS USED TO DO, AND WHY IT WAS WRONG. It set `password_set: false`,
 * and its own comment said the quiet part: with no password set, step one of
 * login issues a token on a name and an id number alone. So "reset the
 * password" REMOVED the password — and both of the things it removed it in
 * favour of are printed on the staff list. Anyone who could read that list
 * could then sign in as whoever they liked, and the screen said the reset had
 * worked.
 *
 * Now it issues a real temporary password, shown to the administrator once,
 * and flags the account: that password opens exactly one screen — the one that
 * replaces it — and nothing else until it has been replaced.
 */
async function resetPassword(req, res, next) {
  try {
    const { temp_password } = req.body || {};

    // Readable down a telephone: no l/I/0/O, and grouped.
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    const pick = (n) => Array.from(require('crypto').randomBytes(n))
      .map((b) => alphabet[b % alphabet.length]).join('');
    const password = temp_password && String(temp_password).length >= 4
      ? String(temp_password)
      : `${pick(4)}-${pick(4)}`;

    const user = await User.findByIdAndUpdate(req.params.id, {
      password_hash: await bcrypt.hash(password, 10),
      password_set: true,
      must_change_password: true,
    }, { new: true }).select('full_name id_number password_set');
    if (!user) return res.status(404).json({ error: 'משתמש לא נמצא' });

    res.json({
      ok: true,
      full_name: user.full_name,
      id_number: user.id_number || '',
      temp_password: password,
    });
  } catch (err) { next(err); }
}

async function emailDiagnostic(req, res, next) {
  const env = require('../config/env');
  const info = {
    active_provider: env.GAS_EMAIL_URL ? 'gas' : (env.RESEND_API_KEY ? 'resend' : (env.SMTP_USER ? 'smtp' : 'none')),
    gas_url_set: !!env.GAS_EMAIL_URL,
    gas_secret_set: !!env.GAS_EMAIL_SECRET,
    resend_key_set: !!env.RESEND_API_KEY,
    resend_key_length: env.RESEND_API_KEY ? env.RESEND_API_KEY.length : 0,
    resend_from: env.RESEND_FROM || '(default: onboarding@resend.dev)',
    smtp_host: env.SMTP_HOST || null,
    smtp_port: env.SMTP_PORT || null,
    smtp_user_set: !!env.SMTP_USER,
    smtp_user_value: env.SMTP_USER || null,
    smtp_pass_set: !!env.SMTP_PASS,
    smtp_pass_length: env.SMTP_PASS ? env.SMTP_PASS.length : 0,
    smtp_pass_has_spaces: env.SMTP_PASS ? /\s/.test(env.SMTP_PASS) : false,
  };
  res.json(info);
}

async function emailTest(req, res, next) {
  try {
    const env = require('../config/env');
    const { dispatchEmail } = require('../services/email.service');
    if (!env.GAS_EMAIL_URL && !env.RESEND_API_KEY && !env.SMTP_USER) {
      return res.status(400).json({
        ok: false,
        error: 'אין ספק מייל מוגדר — הגדר GAS_EMAIL_URL (מומלץ) או RESEND_API_KEY או SMTP_USER+SMTP_PASS',
      });
    }
    const to = req.body?.to || req.user?.email || env.SMTP_USER || 'dreamgan10@gmail.com';
    const info = await dispatchEmail({
      to,
      subject: 'בדיקת מייל — גן החלומות',
      text: 'אם הגיע — המערכת מוגדרת נכון.',
      html: '<div dir="rtl" style="font-family:Arial"><h2>המייל פעיל</h2><p>אם הגיע — ההגדרות תקינות.</p></div>',
    });
    res.json({ ok: true, messageId: info.messageId, provider: info.provider, sent_to: to });
  } catch (err) {
    console.error('emailTest failed:', err);
    res.status(500).json({
      ok: false,
      code: err.code,
      responseCode: err.responseCode,
      command: err.command,
      message: err.message,
      detail: err.detail,
    });
  }
}

module.exports = {
  listUsers, updateUserTabs, updateUserRole, resetPassword,
  getRoleTabs, setRoleTabs, emailDiagnostic, emailTest,
  listCustomRoles, createCustomRoleFromUser, updateCustomRole, deleteCustomRole,
  effectiveTabSet,
};
