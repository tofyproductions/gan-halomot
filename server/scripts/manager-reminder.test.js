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
  const missing = [
    { date: '2026-08-13', full_name: 'נטע בראון', punch_hhmm: '07:31' },
    { date: '2026-08-26', full_name: 'אילנה שמחי', punch_hhmm: '13:52' },
  ];
  const dups = [{ date: '2026-08-05', full_name: 'קרן בן שבת', punches: [1, 2, 3, 4] }];
  const req = { get: (h) => (h === 'host' ? 'gan-halomot.onrender.com' : null), protocol: 'https' };
  const text = c.buildReminderText('כפר סבא - משה דיין', '2026-08', missing, dups, req);

  ok(text.includes(c.punchFixLink('2026-08', req)), 'ההודעה מכילה קישור ישיר למסך ההשלמה');
  ok(text.includes('2 ימים עם החתמה חסרה'), 'ומספרת כמה ימים חסרים');
  ok(text.includes('1 ימים עם החתמה כפולה'), 'וכמה כפולים');

  // Forty lines of names pushed the link below WhatsApp's "read more", and the
  // list was stale the moment somebody fixed a day. The screen behind the link
  // never is.
  ok(!text.includes('נטע בראון'), 'ואינה מפרטת שמות — הרשימה נמצאת בקישור');
  ok(!text.includes('07:31'), 'ולא שעות');
  ok(text.split('\n').length < 10, `ההודעה קצרה (${text.split('\n').length} שורות)`);
}

console.log('\nהכתובת בקישור');
{
  // Render terminates TLS at its proxy, so the socket underneath is plain http
  // and only this header says what the browser actually asked for.
  const req = {
    get: (h) => ({ host: 'gan-halomot.onrender.com', 'x-forwarded-proto': 'https' }[h] || null),
    protocol: 'http',
  };
  const link = c.punchFixLink('2026-08', req);
  ok(link.startsWith('https://gan-halomot.onrender.com/'),
    'הכתובת נלקחת מהבקשה — FRONTEND_URL לא מוגדר בייצור ושלח את כולם ל-localhost');
  ok(link.includes('fix=1'), 'והקישור מסומן כך שהמסך ייפתח מיד');
  ok(link.includes('month=2026-08'), 'ועם החודש הנכון');

  // Behind Render's proxy the socket is plain http; the header is what says the
  // browser asked for https. Without it the link downgrades and the browser
  // warns on a page that asks for a password.
  const plain = c.punchFixLink('2026-08', { get: (h) => (h === 'host' ? 'x.onrender.com' : null), protocol: 'http' });
  ok(plain.startsWith('http://'), 'בלי הכותרת — נשארים במה שהבקשה אמרה');
  ok(c.punchFixLink('2026-08', null).length > 0, 'ובלי בקשה בכלל — עדיין מחזיר כתובת');
}

console.log('\nהיום הנוכחי');
{
  // The rule punchIssues applies, stated here so it can be checked without a
  // month of punches in a database: a lone punch is an unfinished pair only
  // once the day is over. Israel time, because at 01:00 UTC Jerusalem is
  // already on the next date and yesterday's real omissions must still show.
  const todayIL = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  const isMissing = (date) => date < todayIL;

  ok(!isMissing(todayIL), 'היום עצמו אינו החתמה חסרה — העובדות עדיין בעבודה');
  const y = new Date(); y.setDate(y.getDate() - 1);
  ok(isMissing(y.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' })),
    'אתמול כן — היום נגמר וההחתמה באמת חסרה');
  ok(!isMissing('2099-01-01'), 'ויום עתידי לא נספר');
  ok(isMissing('2026-08-13'), 'ויום ישן בהחלט כן');
}

console.log(`\n${failures === 0 ? '✅ הכל עבר' : `❌ ${failures} נכשלו`}\n`);
process.exit(failures === 0 ? 0 : 1);
