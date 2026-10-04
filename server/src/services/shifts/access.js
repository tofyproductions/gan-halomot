/**
 * Who may see and who may change a branch's rota — shared by the rota and the
 * constraints services, so neither has to require the other.
 */
class ShiftError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

const OFFICE = ['system_admin', 'accountant'];
const VIEW_ALL = ['system_admin', 'accountant', 'admin_viewer'];

function managedBranches(user) {
  const managed = (user.managed_branch_ids || []).map(String);
  return managed.length ? managed : (user.branch_id ? [String(user.branch_id)] : []);
}
function canView(user, branchId) {
  if (!user) return false;
  if (VIEW_ALL.includes(user.role)) return true;
  return user.role === 'branch_manager' && managedBranches(user).includes(String(branchId));
}
function canEdit(user, branchId) {
  return !!user && user.role === 'branch_manager' && managedBranches(user).includes(String(branchId));
}
function assertView(user, branchId) { if (!canView(user, branchId)) throw new ShiftError(403, 'אין הרשאה לסניף הזה'); }
function assertEdit(user, branchId) { if (!canEdit(user, branchId)) throw new ShiftError(403, 'רק מנהלת הסניף עורכת את הסידור'); }

module.exports = { ShiftError, OFFICE, VIEW_ALL, canView, canEdit, assertView, assertEdit };
