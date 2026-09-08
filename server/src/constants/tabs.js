/**
 * The tab ids and their role defaults — the server's copy.
 *
 * THIS FILE IS A MIRROR OF client/src/config/tabs.js AND THE TWO MUST STAY IN
 * SYNC. The client owns the labels, the paths and the grouping; none of that
 * means anything here. What the server needs is the third line of the
 * precedence — "which roles get this tab when nobody overrode it" — because
 * custom roles are built by computing a person's EFFECTIVE tab set on the
 * server (admin.controller#createCustomRoleFromUser), and the effective set
 * starts from the role defaults. The client file is ESM and full of JSX-era
 * imports, so it cannot simply be required from here.
 *
 * `null` = every authenticated user, exactly as in the client file.
 *
 * scripts/tabs-constant-sync.test.js (`npm run test:tabs-sync`) reads the
 * client file and fails if a tab exists on one side and not the other, or if
 * any tab's defaultRoles differ. A tab added to the client and forgotten here
 * is a tab a custom role would silently drop.
 */

// Mirrors EMPLOYEE_ROLES in client/src/config/tabs.js.
const EMPLOYEE_ROLES = ['teacher', 'assistant', 'class_leader', 'cook'];

const TAB_DEFAULT_ROLES = {
  // ניהול
  dashboard: ['system_admin', 'admin_viewer', 'branch_manager', 'accountant'],
  leads: ['system_admin', 'admin_viewer', 'branch_manager', 'accountant'],
  registrations: ['system_admin', 'admin_viewer', 'branch_manager'],
  clicktac: ['system_admin', 'admin_viewer', 'accountant', 'branch_manager'],
  // Not a screen — the write grant for רישום חיצוני. See the client file.
  clicktac_write: ['system_admin', 'accountant'],
  collections: ['system_admin', 'admin_viewer', 'accountant'],
  proposed_changes: ['system_admin', 'accountant', 'admin_viewer'],
  parent_letters: ['system_admin', 'admin_viewer', 'branch_manager', 'accountant'],
  parent_supply_list: ['system_admin', 'admin_viewer', 'branch_manager', 'accountant'],
  pricing: ['system_admin', 'admin_viewer', 'branch_manager', 'accountant'],
  archive: ['system_admin', 'admin_viewer', 'branch_manager'],
  branch_certifications: ['system_admin', 'admin_viewer', 'branch_manager', 'accountant'],

  // כוח אדם
  employees: ['system_admin', 'admin_viewer', 'branch_manager', 'accountant'],
  recruitment: ['system_admin', 'admin_viewer', 'branch_manager', 'accountant'],
  attendance: ['system_admin', 'admin_viewer', 'branch_manager'],
  payroll: ['system_admin', 'admin_viewer', 'accountant'],
  payroll_updates: ['system_admin', 'admin_viewer', 'accountant', 'branch_manager'],
  branch_payslips: ['system_admin', 'admin_viewer', 'accountant', 'branch_manager'],
  holidays: ['system_admin', 'admin_viewer', 'branch_manager'],
  employee_requests: ['system_admin', 'admin_viewer', 'branch_manager'],
  employee_letters: ['system_admin', 'admin_viewer', 'branch_manager', 'accountant'],
  form_101: ['system_admin', 'admin_viewer', 'branch_manager', 'accountant'],
  courses: ['system_admin', 'admin_viewer', 'branch_manager', 'accountant'],

  // תפעול
  nursery: ['system_admin', 'admin_viewer', 'branch_manager', 'class_leader', 'teacher', 'assistant'],
  supplies: ['system_admin', 'admin_viewer', 'branch_manager', 'class_leader', 'teacher', 'assistant'],
  parent_changes: ['system_admin', 'admin_viewer', 'branch_manager', 'accountant', 'class_leader'],
  photos: ['system_admin', 'admin_viewer', 'branch_manager', 'class_leader', 'teacher', 'assistant'],
  gifts: ['system_admin', 'admin_viewer', 'branch_manager', 'class_leader', 'accountant'],
  gantt: ['system_admin', 'admin_viewer', 'branch_manager', 'class_leader'],
  classes: ['system_admin', 'admin_viewer', 'branch_manager', 'class_leader', 'accountant'],
  events: ['system_admin', 'admin_viewer', 'branch_manager'],
  announcements: ['system_admin', 'admin_viewer', 'branch_manager', 'class_leader', 'teacher'],
  absences: ['system_admin', 'admin_viewer', 'branch_manager', 'accountant', 'class_leader', 'teacher'],
  pickup: ['system_admin', 'admin_viewer', 'branch_manager', 'class_leader', 'teacher', 'assistant'],
  contacts: null,

  // אחזקה ולוגיסטיקה
  orders: ['system_admin', 'admin_viewer', 'branch_manager', 'class_leader'],
  stock: ['system_admin', 'admin_viewer', 'branch_manager', 'class_leader', 'cook'],
  suppliers: ['system_admin', 'admin_viewer', 'accountant'],
  maintenance: ['system_admin', 'admin_viewer', 'branch_manager', 'class_leader'],

  // האזור שלי
  my_salary: EMPLOYEE_ROLES,
  my_payslips: EMPLOYEE_ROLES,
  my_documents: EMPLOYEE_ROLES,
  my_attendance: EMPLOYEE_ROLES,
  my_updates: EMPLOYEE_ROLES,
};

const ALL_TAB_IDS = Object.keys(TAB_DEFAULT_ROLES);

/** The tab ids a role gets with no override anywhere — the third precedence line. */
function defaultTabsForRole(role) {
  return ALL_TAB_IDS.filter((id) => {
    const roles = TAB_DEFAULT_ROLES[id];
    return roles === null || roles.includes(role);
  });
}

module.exports = { TAB_DEFAULT_ROLES, ALL_TAB_IDS, EMPLOYEE_ROLES, defaultTabsForRole };
