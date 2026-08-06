/**
 * Employee → User synchronization.
 *
 * `Employee` is the payroll card; `User` is the login/permissions record. They
 * are linked by `Employee.user_id`, and the business key that ties them is the
 * 9-digit israeli_id (which is also the userId on the TIMEDOX clock).
 *
 * Historically only `createEmployee` ever touched User, and it hardcoded
 * `role: 'teacher'` — so a "מנהלת" got a teacher login, and an employee who
 * received her ת"ז in a later edit got no login at all (11 active employees
 * were in exactly that state). This service is the single place that keeps the
 * two records in step, from both create and update.
 *
 * Role handling is deliberately conservative:
 *   - The role is derived from `position` ONLY when the position actually
 *     changed (or on creation). Otherwise an admin who hand-picks a role in
 *     "ניהול הרשאות" would see it silently reverted the next time anyone saved
 *     the employee card.
 *   - `system_admin` and `accountant` are never assigned or removed from a
 *     position — those are deliberate grants that no job title implies.
 */
const bcrypt = require('bcryptjs');
const { User } = require('../models');

/** 9-digit ת"ז, or '' when the value can't be one. */
function normalizeIsraeliId(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 9) return '';
  const padded = digits.padStart(9, '0');
  return padded === '000000000' ? '' : padded;
}

/**
 * Job title (Employee.position, free text from a fixed dropdown) → login role.
 * Matches loosely so masculine/feminine spellings both land ("מנהל"/"מנהלת").
 * Returns null when the title says nothing about access ("אחר", empty) — the
 * caller then falls back to `teacher`, the least-privileged staff role.
 */
function roleForPosition(position) {
  const p = String(position || '').trim();
  if (!p) return null;
  if (/הנה"?ח|הנהלת חשבונות|חשב/.test(p)) return 'accountant';
  if (/מנהל/.test(p)) return 'branch_manager';
  if (/מובילת? כיתה|גננת אחראית/.test(p)) return 'class_leader';
  if (/סייע|מטפל/.test(p)) return 'assistant';
  if (/מבשל|טבח/.test(p)) return 'cook';
  if (/גננת|גנן/.test(p)) return 'teacher';
  return null;
}

// Roles a job title is allowed to hand out or take away. `system_admin` is
// excluded on purpose: nothing in the employee card should ever grant or strip
// full system access. `accountant` IS assignable (there is a matching title)
// but is never taken away by a position that maps elsewhere.
const POSITION_ASSIGNABLE = new Set(['branch_manager', 'class_leader', 'teacher', 'assistant', 'cook', 'accountant']);
const ROLE_NEVER_DOWNGRADED = new Set(['system_admin', 'accountant']);

/**
 * Create the login for an employee if she doesn't have one, and keep the
 * identity fields on an existing login in step with the payroll card.
 *
 * @param {Document} emp        a live Employee mongoose document
 * @param {object}   opts
 * @param {boolean}  opts.positionChanged  push position→role on this pass
 * @param {boolean}  opts.isNew            employee was just created
 * @returns {{ user: Document|null, created: boolean, reason?: string }}
 */
async function syncEmployeeUser(emp, { positionChanged = false, isNew = false } = {}) {
  if (!emp) return { user: null, created: false, reason: 'no-employee' };

  const idNumber = normalizeIsraeliId(emp.israeli_id);
  if (!idNumber) return { user: null, created: false, reason: 'no-israeli-id' };

  // Prefer the explicit link; fall back to the ת"ז so an employee created
  // before the link existed adopts her account instead of getting a second one.
  let user = emp.user_id ? await User.findById(emp.user_id) : null;
  if (!user) user = await User.findOne({ id_number: idNumber });

  const derivedRole = roleForPosition(emp.position);

  if (!user) {
    const email = `${idNumber}@gan-halomot.local`;
    // A stale account may hold the address without carrying the ת"ז (email is
    // unique — creating over it would throw). Adopt it rather than fail.
    const byEmail = await User.findOne({ email });
    if (byEmail) {
      user = byEmail;
    } else {
      // Initial password = the ת"ז. `password_set` stays false, so she logs in
      // with name+ID and is prompted to choose a real password (see auth flow).
      const hash = await bcrypt.hash(idNumber, 10);
      user = await User.create({
        email,
        password_hash: hash,
        password_set: false,
        full_name: emp.full_name,
        id_number: idNumber,
        role: (derivedRole && POSITION_ASSIGNABLE.has(derivedRole)) ? derivedRole : 'teacher',
        branch_id: emp.branch_id || null,
        managed_branch_ids: derivedRole === 'branch_manager' && emp.branch_id ? [emp.branch_id] : [],
        position: emp.position || '',
        phone: emp.phone || '',
        is_active: emp.is_active !== false,
      });
      if (String(emp.user_id || '') !== String(user._id)) {
        emp.user_id = user._id;
        await emp.save();
      }
      return { user, created: true };
    }
  }

  // --- existing account: keep it in step ---------------------------------
  const before = {
    role: user.role,
    managed: (user.managed_branch_ids || []).map(String).join(','),
  };
  let dirty = false;
  const set = (field, value) => {
    if (value === undefined || value === null) return;
    if (String(user[field] ?? '') === String(value ?? '')) return;
    user[field] = value;
    dirty = true;
  };

  set('id_number', idNumber);
  set('full_name', emp.full_name);
  set('position', emp.position || '');
  if (emp.phone) set('phone', emp.phone);
  if (emp.branch_id) set('branch_id', emp.branch_id);
  if (user.is_active !== (emp.is_active !== false)) {
    user.is_active = emp.is_active !== false;
    dirty = true;
  }

  // Role: only on creation-time link or a real position change, and never
  // stripping a deliberately-granted admin/accountant role.
  if ((positionChanged || isNew) && derivedRole && POSITION_ASSIGNABLE.has(derivedRole)) {
    if (!ROLE_NEVER_DOWNGRADED.has(user.role) || derivedRole === user.role) {
      set('role', derivedRole);
    }
  }

  // A branch manager needs at least her own branch in managed_branch_ids —
  // that list, not branch_id, is what gates which branches she can see.
  if (user.role === 'branch_manager' && emp.branch_id) {
    const managed = (user.managed_branch_ids || []).map(String);
    const empBranch = String(emp.branch_id);
    if (managed.length === 0) {
      user.managed_branch_ids = [emp.branch_id];
      dirty = true;
    } else if (managed.length === 1 && managed[0] !== empBranch && before.role === 'branch_manager') {
      // Single-branch manager who moved branches — retarget. A multi-branch
      // manager is left alone; that list was set by hand.
      user.managed_branch_ids = [emp.branch_id];
      dirty = true;
    } else if (!managed.includes(empBranch) && before.role !== 'branch_manager') {
      // Just promoted from another role: seed with her own branch.
      user.managed_branch_ids = [...(user.managed_branch_ids || []), emp.branch_id];
      dirty = true;
    }
  }

  if (dirty) await user.save();

  if (String(emp.user_id || '') !== String(user._id)) {
    emp.user_id = user._id;
    await emp.save();
  }

  return { user, created: false, updated: dirty, previous: before };
}

module.exports = { syncEmployeeUser, roleForPosition, normalizeIsraeliId };
