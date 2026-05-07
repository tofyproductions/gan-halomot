// Single source of truth for nav tabs + per-role default access.
// Each tab has a stable `id` used by the per-user override system in User.tab_overrides_*.
// Server JWT carries `tab_overrides_add` and `tab_overrides_remove`; the client computes
// effective access via hasTabAccess(user, tabId).
//
// `defaultRoles: null` = visible to every authenticated user.
// `defaultRoles: [...]` = role-gated; admin can still grant via override.

export const EMPLOYEE_ROLES = ['teacher', 'assistant', 'class_leader', 'cook'];

export const TAB_GROUPS = [
  {
    label: 'ניהול',
    items: [
      { id: 'dashboard',      label: 'לוח בקרה', path: '/',                  defaultRoles: null },
      { id: 'registrations',  label: 'רישום',     path: '/registrations',     defaultRoles: ['system_admin', 'branch_manager'] },
      { id: 'collections',    label: 'גבייה',     path: '/collections',       defaultRoles: ['system_admin', 'accountant'] },
      { id: 'archive',        label: 'ארכיון',    path: '/archive',           defaultRoles: ['system_admin', 'branch_manager'] },
    ],
  },
  {
    label: 'כוח אדם',
    items: [
      { id: 'employees',          label: 'עובדים',  path: '/employees',          defaultRoles: ['system_admin', 'branch_manager'] },
      { id: 'attendance',         label: 'החתמות',  path: '/attendance',         defaultRoles: ['system_admin', 'branch_manager'] },
      { id: 'salary_table',       label: 'שכר',     path: '/salary-table',       defaultRoles: ['system_admin', 'accountant'] },
      { id: 'holidays',           label: 'חופשות',  path: '/holidays',           defaultRoles: ['system_admin', 'branch_manager'] },
      { id: 'employee_requests',  label: 'בקשות',   path: '/employee-requests',  defaultRoles: ['system_admin', 'branch_manager'] },
    ],
  },
  {
    label: 'תפעול',
    items: [
      { id: 'orders',     label: 'הזמנות',     path: '/orders',     defaultRoles: ['system_admin', 'branch_manager', 'class_leader'] },
      { id: 'stock',      label: 'מעקב מלאי',  path: '/stock',      defaultRoles: ['system_admin', 'branch_manager', 'class_leader', 'cook'] },
      { id: 'suppliers',  label: 'ספקים',      path: '/suppliers',  defaultRoles: ['system_admin', 'accountant'] },
      { id: 'gantt',      label: 'גאנט',       path: '/gantt',      defaultRoles: ['system_admin', 'branch_manager', 'class_leader'] },
      { id: 'contacts',   label: 'דף קשר',     path: '/contacts',   defaultRoles: null },
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

export function hasTabAccess(user, tabId) {
  if (!user) return false;
  const tab = TAB_BY_ID[tabId];
  if (!tab) return false;
  if ((user.tab_overrides_remove || []).includes(tabId)) return false;
  if ((user.tab_overrides_add || []).includes(tabId)) return true;
  return isDefaultAllowed(user, tab);
}
