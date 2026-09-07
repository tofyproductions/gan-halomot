#!/usr/bin/env node
/**
 * The viewer role's rules, without a request in flight: which requests are
 * reads, which paths are off limits, who approves what, what the approver
 * will read on the card.
 *
 *   node scripts/viewer-helpers.test.js
 */
const v = require('../src/utils/viewer');

let failures = 0;
const ok = (cond, label) => { console.log(`  ${cond ? '✅' : '❌'} ${label}`); if (!cond) failures++; };
const eq = (a, b, label) => {
  const good = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  ${good ? '✅' : '❌'} ${label}${good ? '' : `  (קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)})`}`);
  if (!good) failures++;
};

console.log('\n👀 כללי הצופה\n');

console.log('קריאה או כתיבה');
eq(['GET', 'HEAD', 'OPTIONS'].map(m => v.isRead({ method: m })), [true, true, true], 'GET/HEAD/OPTIONS = קריאה');
eq(['POST', 'PUT', 'PATCH', 'DELETE'].map(m => v.isRead({ method: m })), [false, false, false, false], 'כל השאר = כתיבה');

console.log('\nמי צופה');
ok(v.isViewer({ role: 'admin_viewer' }), 'admin_viewer הוא צופה');
ok(!v.isViewer({ role: 'system_admin' }) && !v.isViewer(null), 'אף אחד אחר לא');

console.log('\nאזורים חסומים');
ok(v.isBlockedForViewer('/api/admin/users'), '/api/admin חסום');
ok(v.isBlockedForViewer('/api/admin/role-tabs?x=1'), 'גם עם שאילתה');
ok(!v.isBlockedForViewer('/api/administration'), 'רק הקידומת המדויקת, לא כל מה שמתחיל ב-admin');
ok(!v.isBlockedForViewer('/api/employees'), 'שאר המסכים פתוחים');

console.log('\nחסימת כתיבה על הצעות');
ok(v.isWriteBlockedForViewer('/api/proposed-changes/1/decide'), 'הכרעה על הצעה חסומה');
ok(!v.isWriteBlockedForViewer('/api/employees'), 'שאר המסכים לא חסומים לכתיבה');

console.log('\nקבצים');
ok(v.isMultipart({ headers: { 'content-type': 'multipart/form-data; boundary=abc' } }), 'multipart מזוהה');
ok(!v.isMultipart({ headers: { 'content-type': 'application/json' } }), 'JSON לא');
ok(!v.isMultipart({ headers: {} }), 'בלי כותרת — לא');

console.log('\nמי מאשר');
eq(v.approverFor('/api/payroll-month/x'), 'accountant', 'טבלת שכר → הנה"ח');
eq(v.approverFor('/api/payroll/punches/1'), 'accountant', 'החתמות → הנה"ח');
eq(v.approverFor('/api/rate-changes'), 'accountant', 'תעריפים → הנה"ח');
eq(v.approverFor('/api/collections/1'), 'accountant', 'גבייה → הנה"ח');
eq(v.approverFor('/api/children/1'), 'system_admin', 'ילדים → מנהל מערכת');
eq(v.approverFor('/api/gan-events'), 'system_admin', 'אירועים → מנהל מערכת');
eq(v.approverFor('/api/payroll-something-else'), 'system_admin', 'קידומת דומה אך שונה → מנהל מערכת');

console.log('\nשם המסך');
eq(v.screenLabelFor('/api/employees/5'), 'עובדים', 'עובדים');
eq(v.screenLabelFor('/api/payroll-month/5?month=2026-09'), 'שכר', 'שכר, בלי השאילתה');
eq(v.screenLabelFor('/api/nothing-like-this'), 'מסך אחר', 'לא ידוע');

console.log('\nתקציר לכרטיס');
eq(v.summarizeBody({ full_name: 'דנה', hourly_rate: 45, active: true, note: '', nested: { a: 1 }, list: [1, 2] }), [
  { key: 'full_name', label: 'שם מלא', value: 'דנה' },
  { key: 'hourly_rate', label: 'שכר שעתי', value: '45' },
  { key: 'active', label: 'active', value: 'כן' },
  { key: 'note', label: 'הערה', value: '—' },
], 'סקלרים בלבד, תוויות ידועות מתורגמות, השאר כשמם');
eq(v.summarizeBody(null), [], 'גוף ריק → רשימה ריקה');
eq(v.summarizeBody(Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, i]))).length, 40, 'לכל היותר 40 שורות');

console.log('\nסניף מהבקשה');
eq(v.extractBranchId({ body: { branch_id: 'b1' }, params: {}, query: {} }), 'b1', 'מהגוף');
eq(v.extractBranchId({ body: {}, params: { branchId: 'b2' }, query: {} }), 'b2', 'מהנתיב');
eq(v.extractBranchId({ body: {}, params: {}, query: { branch: 'b3' } }), 'b3', 'מהשאילתה');
eq(v.extractBranchId({ body: {}, params: {}, query: { branch: 'all' } }), null, '"all" אינו סניף');
eq(v.extractBranchId({}), null, 'בלי כלום → null');

console.log('\nהודעה');
eq(v.viewerMessage('accountant'), 'השינוי נשמר וממתין לאישור הנה"ח', 'להנה"ח');
eq(v.viewerMessage('system_admin'), 'השינוי נשמר וממתין לאישור מנהל המערכת', 'למנהל המערכת');

console.log(failures ? `\n❌ ${failures} כשלונות\n` : '\n✅ הכל עבר\n');
process.exit(failures ? 1 : 0);
