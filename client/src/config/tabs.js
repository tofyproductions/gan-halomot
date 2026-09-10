// Single source of truth for nav tabs + per-role default access.
// Each tab has a stable `id` used by the per-user override system in User.tab_overrides_*.
// Server JWT carries `tab_overrides_add` and `tab_overrides_remove`; the client computes
// effective access via hasTabAccess(user, tabId).
//
// `defaultRoles: null` = visible to every authenticated user.
// `defaultRoles: [...]` = role-gated; admin can still grant via override.

export const EMPLOYEE_ROLES = ['teacher', 'assistant', 'class_leader', 'cook'];

// 'admin_viewer' (מנהל מערכת - לצפייה בלבד) is listed wherever 'system_admin'
// is: the viewer sees every screen the admin sees. Edit rights are decided by
// the server per request, not by the tab.
export const TAB_GROUPS = [
  {
    label: 'ניהול',
    items: [
      // Management overview (child counts, branch KPIs) — NOT for regular staff.
      { id: 'dashboard',      label: 'לוח בקרה', path: '/',                  defaultRoles: ['system_admin', 'admin_viewer', 'branch_manager', 'accountant'] },
      { id: 'leads',          label: 'פניות הורים', path: '/leads',           defaultRoles: ['system_admin', 'admin_viewer', 'branch_manager', 'accountant'] },
      { id: 'registrations',  label: 'רישום',     path: '/registrations',     defaultRoles: ['system_admin', 'admin_viewer', 'branch_manager'] },
      // The supervised branches enroll in קליקטאק and are approved by משרד
      // התמ"ת, so their intake is two files rather than the registration flow —
      // and one page, because neither file answers anything on its own.
      // The id stays 'clicktac': per-user tab permissions are stored by id, and
      // renaming it would revoke the screen from whoever was granted it by hand.
      { id: 'clicktac',       label: 'רישום חיצוני', path: '/external-enrollment', defaultRoles: ['system_admin', 'admin_viewer', 'accountant', 'branch_manager'] },
      // NOT A SCREEN — a WRITE GRANT, and that is why `path` is null.
      //
      // Seeing רישום חיצוני and acting on it are two different things: the tab
      // above is what a branch manager needs in order to READ her own gan's
      // queue, and uploading a קליקטאק or תמ"ת file, undoing an upload,
      // applying a comparison or turning seventy children into registrations is
      // not the same permission. Until now "acting" was hard-wired to
      // system_admin/accountant, so the one person the office actually wanted
      // to hand it to — a מנהל מערכת לצפייה בלבד, or one back-office employee —
      // could not be given it without making her an admin.
      //
      // So the permission itself became a tab id. Granting it per user (or
      // per role) on the permissions screen works exactly like granting a
      // screen, hasTabAccess(user, 'clicktac_write') answers "may this person
      // act there" with the same precedence (per-user override > role override
      // > default roles), and the server reads the very same grant off the JWT
      // (middleware/auth.js#requireTabWrite). Holding it means acting for EVERY
      // branch — the point of the grant is the person who files for all of them
      // — while removing the 'clicktac' tab above still revokes everything.
      //
      // `path: null` keeps it out of the menu; Header.jsx filters on it.
      { id: 'clicktac_write', label: 'רישום חיצוני — קליטת קבצים ופעולות', path: null, defaultRoles: ['system_admin', 'accountant'], writeGrantFor: 'clicktac' },
      { id: 'collections',    label: 'גבייה',     path: '/collections',       defaultRoles: ['system_admin', 'admin_viewer', 'accountant'] },
      // שינויים שביקש "מנהל מערכת - לצפייה בלבד" ומחכים למשרד. The viewer
      // sees his own list on the same screen.
      { id: 'proposed_changes', label: 'שינויים לאישור', path: '/proposed-changes', defaultRoles: ['system_admin', 'accountant', 'admin_viewer'] },
      // אישור שהות ואישור קייטנה — the papers a family asks the office for,
      // filled from the system instead of typed from memory.
      { id: 'parent_letters', label: 'מסמכים להורים', path: '/parent-letters', defaultRoles: ['system_admin', 'admin_viewer', 'branch_manager', 'accountant'] },
      // The equipment-list poster sent to parents (diapers, sheets, a change
      // of clothes) — one shared list, export-to-PNG. Same audience as the
      // documents above, so it sits beside them rather than under חופשות.
      { id: 'parent_supply_list', label: 'רשימת ציוד', path: '/parent-supply-list', defaultRoles: ['system_admin', 'admin_viewer', 'branch_manager', 'accountant'] },
      { id: 'pricing',        label: 'מחירון',    path: '/pricing',           defaultRoles: ['system_admin', 'admin_viewer', 'branch_manager', 'accountant'] },
      { id: 'archive',        label: 'ארכיון',    path: '/archive',           defaultRoles: ['system_admin', 'admin_viewer', 'branch_manager'] },
      // The papers each branch operates under — רישיון הפעלה, חשמלאי, גילוי
      // אש — with the expiry dates the mail digest watches.
      { id: 'branch_certifications', label: 'אישורי מעון', path: '/branch-certifications', defaultRoles: ['system_admin', 'admin_viewer', 'branch_manager', 'accountant'] },
      // Both of these were real routes in App.jsx with no entry here, which
      // meant no row in the rail and no link anywhere in the client — the
      // screen where the 43 screens are handed out was reachable only by
      // typing its address. Either they are screens or they are not.
      { id: 'branches',    label: 'סניפים',  path: '/branches',          defaultRoles: ['system_admin', 'admin_viewer'] },
      { id: 'permissions', label: 'הרשאות',  path: '/admin/permissions', defaultRoles: ['system_admin'] },
    ],
  },
  {
    label: 'כוח אדם',
    items: [
      { id: 'employees',          label: 'עובדים',  path: '/employees',          defaultRoles: ['system_admin', 'admin_viewer', 'branch_manager', 'accountant'] },
      // Candidates from the website's recruitment form. A branch manager sees
      // only the gans she holds — enforced per row on the server, not by the
      // branch dropdown, because these are private phone numbers of people who
      // do not work here.
      { id: 'recruitment',        label: 'גיוס',    path: '/recruitment',        defaultRoles: ['system_admin', 'admin_viewer', 'branch_manager', 'accountant'] },
      { id: 'attendance',         label: 'החתמות',  path: '/attendance',         defaultRoles: ['system_admin', 'admin_viewer', 'branch_manager'] },
      // The salary table itself is accountant/admin. A branch manager files what
      // she knows from 'עדכוני שכר' instead — she has no business seeing every
      // employee's rate and net in order to record a bonus.
      { id: 'payroll',            label: 'שכר',     path: '/payroll',            defaultRoles: ['system_admin', 'admin_viewer', 'accountant'] },
      { id: 'payroll_updates',    label: 'עדכוני שכר חודשי', path: '/payroll-updates', defaultRoles: ['system_admin', 'admin_viewer', 'accountant', 'branch_manager'] },
      // A payslip that was already SENT to the employee, unlike the salary
      // table above it. It is the document her staff bring to her when they
      // think a month is wrong, so she can answer without the accountant.
      { id: 'branch_payslips',    label: 'תלושי עובדים', path: '/branch-payslips', defaultRoles: ['system_admin', 'admin_viewer', 'accountant', 'branch_manager'] },
      { id: 'holidays',           label: 'חופשות',  path: '/holidays',           defaultRoles: ['system_admin', 'admin_viewer', 'branch_manager'] },
      { id: 'employee_requests',  label: 'בקשות',   path: '/employee-requests',  defaultRoles: ['system_admin', 'admin_viewer', 'branch_manager'] },
      { id: 'employee_letters',   label: 'מסמכים לעובד', path: '/employee-letters', defaultRoles: ['system_admin', 'admin_viewer', 'branch_manager', 'accountant'] },
      { id: 'form_101',           label: 'טופסי 101', path: '/form-101',           defaultRoles: ['system_admin', 'admin_viewer', 'branch_manager', 'accountant'] },
      // The tracking sheet, moved in: every עובדת's מד"א and התנהלות בטוחה,
      // when they run out, and the certificate one click away.
      { id: 'courses',            label: 'קורסים והכשרות', path: '/courses',       defaultRoles: ['system_admin', 'admin_viewer', 'branch_manager', 'accountant'] },
    ],
  },
  {
    label: 'תפעול',
    items: [
      // The infant rooms' daily board. Open to the people actually in the
      // room — a teacher needs it more than anyone, and a board filled in by
      // management is a board filled in by somebody who was not there.
      { id: 'nursery',    label: 'לוח תינוקייה', path: '/nursery',  defaultRoles: ['system_admin', 'admin_viewer', 'branch_manager', 'class_leader', 'teacher', 'assistant'] },
      // Same gate as the board: the person who notices the wipes ran out is in
      // the room, not the office.
      { id: 'supplies',   label: 'מה חסר',      path: '/supplies', defaultRoles: ['system_admin', 'admin_viewer', 'branch_manager', 'class_leader', 'teacher', 'assistant'] },
      // Parents correct their own details and the change is live at once; this
      // is where the gan finds out. A class leader is on the list because an
      // allergy is their business before it is management's.
      { id: 'parent_changes', label: 'עדכונים מהורים', path: '/parent-changes', defaultRoles: ['system_admin', 'admin_viewer', 'branch_manager', 'accountant', 'class_leader'] },
      // Whoever takes the photographs uploads them. Requiring a manager means
      // they are uploaded a week later, or not at all.
      { id: 'photos', label: 'תמונות', path: '/photos', defaultRoles: ['system_admin', 'admin_viewer', 'branch_manager', 'class_leader', 'teacher', 'assistant'] },
      // Choosing the photograph that goes on the gift. The person who knows
      // which one looks like the child is in the room, not the office — but
      // OPENING a round sets dates for every branch, so the server keeps that
      // to management.
      { id: 'gifts', label: 'מתנות', path: '/gifts', defaultRoles: ['system_admin', 'admin_viewer', 'branch_manager', 'class_leader', 'accountant'] },
      { id: 'gantt',      label: 'גאנט',       path: '/gantt',      defaultRoles: ['system_admin', 'admin_viewer', 'branch_manager', 'class_leader'] },
      { id: 'classes',    label: 'מעקב חוגים', path: '/classes',    defaultRoles: ['system_admin', 'admin_viewer', 'branch_manager', 'class_leader', 'accountant'] },
      { id: 'events',     label: 'אירועים',    path: '/events',     defaultRoles: ['system_admin', 'admin_viewer', 'branch_manager'] },
      // What the gan tells the families. A teacher writes it — she is the one
      // who knows the trip is on Thursday — and only a branch manager publishes
      // it, takes it to WhatsApp, or spends the SMS budget on it. The server
      // enforces that split; this only decides who sees the screen.
      { id: 'announcements', label: 'הודעות לגן', path: '/announcements', defaultRoles: ['system_admin', 'admin_viewer', 'branch_manager', 'class_leader', 'teacher'] },
      // What the families reported in advance. Read-only, and open to whoever
      // opens the room: a teacher who finds out at 8am that a child is not
      // coming finds out when the child does not come.
      { id: 'absences', label: 'היעדרויות', path: '/absences', defaultRoles: ['system_admin', 'admin_viewer', 'branch_manager', 'accountant', 'class_leader', 'teacher'] },
      // Who may collect a child. SEEING it is wide on purpose — the person at
      // the door is whoever is closing the room — and only a manager grants.
      { id: 'pickup', label: 'מורשי איסוף', path: '/pickup', defaultRoles: ['system_admin', 'admin_viewer', 'branch_manager', 'class_leader', 'teacher', 'assistant'] },
      { id: 'contacts',   label: 'דף קשר',     path: '/contacts',   defaultRoles: null },
    ],
  },
  {
    label: 'אחזקה ולוגיסטיקה',
    items: [
      { id: 'orders',       label: 'הזמנות',     path: '/orders',       defaultRoles: ['system_admin', 'admin_viewer', 'branch_manager', 'class_leader'] },
      { id: 'stock',        label: 'מעקב מלאי',  path: '/stock',        defaultRoles: ['system_admin', 'admin_viewer', 'branch_manager', 'class_leader', 'cook'] },
      { id: 'suppliers',    label: 'ספקים',      path: '/suppliers',    defaultRoles: ['system_admin', 'admin_viewer', 'accountant'] },
      { id: 'maintenance',  label: 'אחזקה',      path: '/maintenance',  defaultRoles: ['system_admin', 'admin_viewer', 'branch_manager', 'class_leader'] },
    ],
  },
  {
    label: 'האזור שלי',
    items: [
      { id: 'my_salary',     label: 'צפי השכר שלי',  path: '/my-salary',     defaultRoles: EMPLOYEE_ROLES },
      { id: 'my_payslips',   label: 'התלושים שלי',   path: '/my-payslips',   defaultRoles: EMPLOYEE_ROLES },
      { id: 'my_documents',  label: 'המסמכים שלי',   path: '/my-documents',  defaultRoles: EMPLOYEE_ROLES },
      { id: 'my_attendance', label: 'ההחתמות שלי',   path: '/my-attendance', defaultRoles: EMPLOYEE_ROLES },
      { id: 'my_updates',    label: 'עדכונים',       path: '/my-updates',    defaultRoles: EMPLOYEE_ROLES },
    ],
  },
];

export const ALL_TABS = TAB_GROUPS.flatMap(g => g.items.map(it => ({ ...it, group: g.label })));
export const TAB_BY_ID = Object.fromEntries(ALL_TABS.map(t => [t.id, t]));

export function isDefaultAllowed(user, tab) {
  if (!user) return false;
  if (!tab.defaultRoles) return true;
  return tab.defaultRoles.includes(user.role);
}

/**
 * Access precedence (highest first):
 *   1. per-user override   (tab_overrides_add / tab_overrides_remove)
 *   2. role-wide override  (role_tab_add / role_tab_remove — set once by the
 *      admin for a whole role, delivered on the user payload)
 *   3. the role default from TAB_GROUPS
 */
export function hasTabAccess(user, tabId) {
  if (!user) return false;
  const tab = TAB_BY_ID[tabId];
  if (!tab) return false;
  // 1. per-user
  if ((user.tab_overrides_remove || []).includes(tabId)) return false;
  if ((user.tab_overrides_add || []).includes(tabId)) return true;
  // 2. role-wide
  if ((user.role_tab_remove || []).includes(tabId)) return false;
  if ((user.role_tab_add || []).includes(tabId)) return true;
  // 3. default
  return isDefaultAllowed(user, tab);
}

/**
 * Effective access for a ROLE (default + role-wide override) — admin UI helper.
 *
 * `customRole` is the fourth line only because a custom role is not a fourth
 * precedence level: it REPLACES the role layer for whoever holds it. Pass it
 * and the role-wide override for the base role is not consulted at all, which
 * is exactly what the server does when it mints the token
 * (auth.controller#effectiveRoleTabs).
 */
export function roleHasTab(role, tabId, roleTabs = {}, customRole = null) {
  if (customRole) return customRoleHasTab(customRole, tabId);
  const tab = TAB_BY_ID[tabId];
  if (!tab) return false;
  const entry = roleTabs[role] || {};
  if ((entry.remove || []).includes(tabId)) return false;
  if ((entry.add || []).includes(tabId)) return true;
  return isDefaultAllowed({ role }, tab);
}

/**
 * Effective access for a CUSTOM role — its own add/remove lists over the
 * DEFAULTS of its base role. See server/src/models/CustomRole.js.
 *
 * `customRole` is `{ base_role, tab_add, tab_remove }`.
 */
export function customRoleHasTab(customRole, tabId) {
  const tab = TAB_BY_ID[tabId];
  if (!tab || !customRole) return false;
  if ((customRole.tab_remove || []).includes(tabId)) return false;
  if ((customRole.tab_add || []).includes(tabId)) return true;
  return isDefaultAllowed({ role: customRole.base_role }, tab);
}
