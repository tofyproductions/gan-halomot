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

/**
 * `classroom_board` — "לוח כיתה": the tablet on the wall of one room.
 *
 * Not a person. One account per classroom, opened from a link, unlocked with a
 * password once and with the tablet's own fingerprint after that, and left
 * logged in all day where anybody in the room can reach it — which is the
 * whole point and also the whole risk. It sees ONE room's daily board and that
 * room's photographs, and nothing else in this system: no other class, no
 * employee, no salary, no parent's telephone number. A tablet that walks out
 * of the gan is worth what is on that one screen.
 */
const CLASSROOM_BOARD = 'classroom_board';

const ROLES = [
  'system_admin', 'branch_manager', 'accountant',
  'class_leader', 'teacher', 'assistant', 'cook',
  ADMIN_VIEWER, CLASSROOM_BOARD,
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
  [CLASSROOM_BOARD]: 'לוח כיתה',
};

module.exports = { ROLES, ADMIN_VIEWER, CLASSROOM_BOARD, ROLE_LABELS };
