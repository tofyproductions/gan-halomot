/**
 * The one list of roles. The User model's enum, the admin API that assigns
 * roles, and the tests all read this — a role that exists in one place and
 * not another is a role that cannot be given, or cannot be saved.
 *
 * `admin_viewer` — "מנהל מערכת - לצפייה בלבד": reads everything a system
 * admin reads, across every branch; acts as a branch manager inside its own
 * managed_branch_ids; every other write is queued for approval instead of
 * written. See utils/viewer.js and middleware/auth.js#requireRole.
 */
const ADMIN_VIEWER = 'admin_viewer';

const ROLES = [
  'system_admin', 'branch_manager', 'accountant',
  'class_leader', 'teacher', 'assistant', 'cook',
  ADMIN_VIEWER,
];

const ROLE_LABELS = {
  system_admin: 'מנהל מערכת',
  branch_manager: 'מנהל סניף',
  accountant: 'הנה"ח',
  class_leader: 'גננת אחראית',
  teacher: 'גננת',
  assistant: 'סייעת',
  cook: 'מבשלת',
  [ADMIN_VIEWER]: 'מנהל מערכת - לצפייה בלבד',
};

module.exports = { ROLES, ADMIN_VIEWER, ROLE_LABELS };
