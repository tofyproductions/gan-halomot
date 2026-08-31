#!/usr/bin/env node
/**
 * Reaching the branch manager.
 *
 * Two rows describe one manager: the login (User) and the payroll card
 * (Employee). The phone already read both. The email read only the login — so
 * a manager whose address was typed under עובדים, which is where somebody
 * filling in an employee's details naturally puts it, was reported as having no
 * email at all. The screen said "לא נשלח מייל — אין כתובת אמיתית" in small grey
 * text and the reminder went nowhere, while the address sat one row over.
 *
 * The message itself pointed at "היכנסי למערכת ← החתמות" — four steps on a
 * phone, read by somebody standing in a room full of children. It carries the
 * address of the completion screen now.
 *
 *   node scripts/manager-reminder.test.js
 */

const c = require('../src/controllers/payrollMonth.controller');

let failures = 0;
const ok = (cond, label) => { console.log(`  ${cond ? '✅' : '❌'} ${label}`); if (!cond) failures++; };
const eq = (a, b, label) => {
  const good = a === b;
  console.log(`  ${good ? '✅' : '❌'} ${label}${good ? '' : `  (קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)})`}`);
  if (!good) failures++;
};

const user = (over = {}) => ({ _id: 'u1', full_name: 'לידור כהן', email: '', phone: '', ...over });

console.log('\n📬 יצירת קשר עם מנהל/ת הסניף\n');

console.log('מאיפה נלקח המייל');
{
  eq(c.managerContact(user(), { email: 'lidor@gmail.com' }).email, 'lidor@gmail.com',
    'המייל מכרטיס העובד/ת כשאין מייל בחשבון — זה הבאג שדווח');
  eq(c.managerContact(user({ email: 'login@gmail.com' }), { email: 'card@gmail.com' }).email,
    'login@gmail.com',
    'מייל שהוזן בחשבון גובר — שם מפנים מייל בכוונה');

  // The placeholder domains userSync mints for an employee with no address.
  // They resolve to nothing, so mail to them is silently lost.
  eq(c.managerContact(user({ email: 'lidor@gan-halomot.local' }), { email: 'real@gmail.com' }).email,
    'real@gmail.com',
    'כתובת פנימית מדומה אינה כתובת — ממשיכים לכרטיס');
  eq(c.managerContact(user(), { email: 'x@ganhalomot.co.il' }).email, '',
    'וגם בכרטיס היא נפסלת, במקום לשלוח לשום מקום');
  eq(c.managerContact(user(), {}).email, '', 'אין בשום מקום — ריק, וזה מה שהמסך אומר');
}

console.log('\nהטלפון — כמו שהיה');
{
  eq(c.managerContact(user(), { phone: '0501234567' }).phone, '0501234567',
    'טלפון מהכרטיס');
  eq(c.managerContact(user({ phone: '0509999999' }), { phone: '0501234567' }).phone, '0509999999',
    'וטלפון מהחשבון גובר');
}

console.log('\nההודעה');
{
  const missing = [{ date: '2026-08-13', full_name: 'נטע בראון', punch_hhmm: '07:31' }];
  const text = c.buildReminderText('כפר סבא - משה דיין', '2026-08', missing, []);
  const link = c.punchFixLink('2026-08');

  ok(text.includes(link), 'ההודעה מכילה קישור ישיר למסך ההשלמה');
  ok(link.includes('fix=1'), 'והקישור מסומן כך שהמסך ייפתח מיד');
  ok(link.includes('month=2026-08'), 'ועם החודש הנכון');
  ok(!/היכנס.? למערכת →|נא להיכנס למערכת/.test(text),
    'ההוראה בת ארבעת השלבים הוחלפה');
  ok(text.includes('נטע בראון') && text.includes('2026-08-13'),
    'והיום החסר עדיין מפורט בגוף ההודעה');
}

console.log(`\n${failures === 0 ? '✅ הכל עבר' : `❌ ${failures} נכשלו`}\n`);
process.exit(failures === 0 ? 0 : 1);
