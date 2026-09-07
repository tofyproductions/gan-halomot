/**
 * The viewer role ("מנהל מערכת - לצפייה בלבד"), reduced to rules with no
 * request in flight. middleware/auth.js#requireRole applies them; the
 * proposed-changes service reads the labels. Nothing here touches the
 * database or the response.
 */
const { ADMIN_VIEWER } = require('../constants/roles');

const READ_METHODS = ['GET', 'HEAD', 'OPTIONS'];

/** Prefixes (path only, no query) a viewer may not touch at all — not even to read. */
const BLOCKED_PREFIXES = ['/api/admin'];

/**
 * Prefixes a viewer may not WRITE to, even though reading them is fine.
 * Deciding a proposal ('/api/proposed-changes/:id/decide') is itself a
 * write outside the manager fallback (no `branch_manager` in its allowed
 * roles) — proposing THAT would be absurd, so it is refused outright
 * instead of joining the queue it exists to drain.
 */
const WRITE_BLOCKED_PREFIXES = ['/api/proposed-changes'];

/** Path prefixes whose proposals go to the accountant; everything else → system admin. */
const ACCOUNTANT_PREFIXES = [
  '/api/payroll', '/api/payroll-month', '/api/salary-requests', '/api/rate-changes',
  '/api/employment-contracts', '/api/collections', '/api/form-101',
  '/api/employee-letters', '/api/branch-pricing', '/api/suppliers',
];

/** Path prefix → the screen name a person knows. Mirrors client/src/config/tabs.js. */
const SCREEN_LABELS = [
  ['/api/payroll-month', 'שכר'],
  ['/api/payroll', 'שכר'],
  ['/api/salary-requests', 'בקשות העלאה'],
  ['/api/rate-changes', 'שינוי תעריף'],
  ['/api/employment-contracts', 'חוזי העסקה'],
  ['/api/employee-requests', 'בקשות'],
  ['/api/employee-documents', 'מסמכים לעובד'],
  ['/api/employee-letters', 'מסמכים לעובד'],
  ['/api/employees', 'עובדים'],
  ['/api/form-101', 'טופסי 101'],
  ['/api/recruitment', 'גיוס'],
  ['/api/holidays', 'חופשות'],
  ['/api/children', 'ילדים'],
  ['/api/registrations', 'רישום'],
  ['/api/external-enrollments', 'רישום חיצוני'],
  ['/api/tmt', 'רישום חיצוני'],
  ['/api/collections', 'גבייה'],
  ['/api/contracts', 'גבייה'],
  ['/api/leads', 'פניות הורים'],
  ['/api/parent-letters', 'מסמכים להורים'],
  ['/api/parent-changes', 'עדכונים מהורים'],
  ['/api/branch-pricing', 'מחירון'],
  ['/api/discounts', 'מחירון'],
  ['/api/archives', 'ארכיון'],
  ['/api/branches', 'סניפים'],
  ['/api/classrooms', 'כיתות'],
  ['/api/classes', 'מעקב חוגים'],
  ['/api/nursery', 'לוח תינוקייה'],
  ['/api/supplies', 'מה חסר'],
  ['/api/photos', 'תמונות'],
  ['/api/gifts', 'מתנות'],
  ['/api/gantt', 'גאנט'],
  ['/api/gan-events', 'אירועים'],
  ['/api/announcements', 'הודעות לגן'],
  ['/api/absences', 'היעדרויות'],
  ['/api/pickup', 'מורשי איסוף'],
  ['/api/contacts', 'דף קשר'],
  ['/api/orders', 'הזמנות'],
  ['/api/stock', 'מעקב מלאי'],
  ['/api/suppliers', 'ספקים'],
  ['/api/products', 'הזמנות'],
  ['/api/maintenance', 'אחזקה'],
  ['/api/activities', 'פעילויות'],
  ['/api/cibus-sync', 'סיבוס'],
];

/** Body keys the approver will read, in words. Unknown keys stay as they are. */
const FIELD_LABELS = {
  full_name: 'שם מלא', first_name: 'שם פרטי', last_name: 'שם משפחה',
  phone: 'טלפון', email: 'אימייל', note: 'הערה', notes: 'הערות', reason: 'סיבה',
  date: 'תאריך', month: 'חודש', amount: 'סכום', hourly_rate: 'שכר שעתי',
  global_salary: 'שכר גלובלי', salary_type: 'סוג שכר', effective_date: 'מתאריך',
  branch_id: 'סניף', employee_id: 'עובד/ת', child_id: 'ילד/ה', status: 'סטטוס',
  is_active: 'פעיל/ה', title: 'כותרת', description: 'תיאור', timestamp: 'שעה',
  type: 'סוג', start_date: 'מתאריך', end_date: 'עד תאריך',
};

/**
 * The path an HTTP client would actually send, not the string we were handed.
 *
 * A raw `split('?')[0]` compares the URL as typed, while undici/http normalize
 * dot segments before putting them on the wire — so `/api/cibus-sync/%2e%2e/admin/users`
 * passes a `startsWith('/api/admin')` test and then arrives at /api/admin.
 * The WHATWG parser resolves `..`, `%2e%2e` and `//` exactly as the client will.
 */
function pathOnly(url) {
  try {
    return new URL(String(url || ''), 'http://x').pathname;
  } catch {
    return String(url || '').split('?')[0];
  }
}

function isRead(req) {
  return READ_METHODS.includes(String(req?.method || '').toUpperCase());
}

function isViewer(user) {
  return !!user && user.role === ADMIN_VIEWER;
}

function startsWithPrefix(path, prefix) {
  return path === prefix || path.startsWith(prefix + '/') || path.startsWith(prefix + '?');
}

function isBlockedForViewer(url) {
  const path = pathOnly(url);
  return BLOCKED_PREFIXES.some(p => startsWithPrefix(path, p));
}

function isWriteBlockedForViewer(url) {
  const path = pathOnly(url);
  return WRITE_BLOCKED_PREFIXES.some(p => startsWithPrefix(path, p));
}

function isMultipart(req) {
  const ct = req?.headers?.['content-type'] || '';
  return ct.toLowerCase().startsWith('multipart/');
}

function approverFor(url) {
  const path = pathOnly(url);
  return ACCOUNTANT_PREFIXES.some(p => startsWithPrefix(path, p)) ? 'accountant' : 'system_admin';
}

function screenLabelFor(url) {
  const path = pathOnly(url);
  const hit = SCREEN_LABELS.find(([p]) => startsWithPrefix(path, p));
  return hit ? hit[1] : 'מסך אחר';
}

function showValue(v) {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'כן' : 'לא';
  return String(v);
}

function summarizeBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const rows = [];
  for (const [key, value] of Object.entries(body)) {
    if (value !== null && typeof value === 'object') continue;   // nested / arrays: not readable on a card
    rows.push({ key, label: FIELD_LABELS[key] || key, value: showValue(value) });
    if (rows.length >= 40) break;
  }
  return rows;
}

function extractBranchId(req) {
  const cand = req?.body?.branch_id ?? req?.params?.branchId ?? req?.query?.branch ?? null;
  if (cand === null || cand === undefined || cand === '' || cand === 'all') return null;
  return String(cand);
}

function viewerMessage(approver) {
  return `השינוי נשמר וממתין לאישור ${approver === 'accountant' ? 'הנה"ח' : 'מנהל המערכת'}`;
}

module.exports = {
  isRead, isViewer, isBlockedForViewer, isWriteBlockedForViewer, isMultipart, approverFor,
  screenLabelFor, summarizeBody, extractBranchId, viewerMessage, FIELD_LABELS,
};
