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

/**
 * מי ש-`managed_branch_ids` בכלל אומר עליו משהו.
 *
 * זה שדה של הנהלה. על שורה של גננת או סייעת הוא סתם ערך שנשאר שם — ועד
 * עכשיו הוא היה **מחליף** את הסניף שלה במקום להוסיף אליו: מובילת כיתה בקפלן
 * שעל השורה שלה נשאר משה דיין קיבלה 403 על הסניף שבו היא עובדת בפועל, בלי
 * שום דרך להבין למה. הרשימה הזו היא מה שמונע את זה.
 */
const BRANCH_MANAGING_ROLES = ['branch_manager', 'accountant', 'system_admin', ADMIN_VIEWER];

/**
 * מי שהשיוך שלו הוא כיתה ולא סניף.
 *
 * גננת רואה את הכיתה שלה, לא את כל הסניף. כשיש לה `classroom_id` המערכת
 * מצמצמת אליה; כשאין — היא רואה את הסניף כמו קודם, כדי שלא ננעל אף אחת
 * בגלל שדה שלא מולא.
 */
const CLASSROOM_SCOPED_ROLES = ['class_leader', 'teacher', 'assistant'];

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

module.exports = {
  BRANCH_MANAGING_ROLES,
  CLASSROOM_SCOPED_ROLES, ROLES, ADMIN_VIEWER, CLASSROOM_BOARD, ROLE_LABELS };
