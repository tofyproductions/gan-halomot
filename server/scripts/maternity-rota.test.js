#!/usr/bin/env node
/**
 * חופשת לידה מול סידור העבודה.
 *
 * What must hold:
 *
 *   the weekly seed skips her leave days — and only them: a leave that ends
 *     mid-week seeds the days after it;
 *   open-ended dates lean the kind way (no "to" = still on leave);
 *   marking the leave clears her placements from open weeks — only hers,
 *     only inside the leave, never days that already happened;
 *   she is never dropped from the board's employee list — a manual placement
 *     (a gradual return) stays possible, and a hand-placed entry is kept by
 *     the clear only if it is outside the leave.
 *
 *   node scripts/maternity-rota.test.js
 */
try { require.resolve('mongodb-memory-server'); } catch {
  console.error('\n❌  npm install --no-save mongodb-memory-server\n'); process.exit(1);
}
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = { id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) } };
const { MongoMemoryServer } = require('mongodb-memory-server');

let failures = 0;
const eq = (a, b, l) => {
  const g = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  ${g ? '✅' : '❌'} ${l}${g ? '' : ` (${JSON.stringify(a)} ≠ ${JSON.stringify(b)})`}`);
  if (!g) failures++;
};

(async () => {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_SECRET = 'maternity-test';
  const mongoose = require('mongoose');
  await mongoose.connect(process.env.MONGODB_URI);
  const M = require('../src/models');
  const { buildSeedEntries, onMaternityLeave } = require('../src/services/shifts/seed');
  const svc = require('../src/services/shifts/shiftWeek.service');

  console.log('\n🤱 הזריעה השבועית מדלגת על ימי החופשה');
  // A future week, so "from today on" never trims the test's expectations.
  const base = new Date(Date.now() + 14 * 86400000);
  base.setDate(base.getDate() - base.getDay()); // the coming Sunday two weeks out
  const d = (i) => new Date(base.getTime() + i * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  const dates = [0, 1, 2, 3, 4, 5].map(d);

  const empId = new mongoose.Types.ObjectId();
  const mkEmp = (extra) => ({ _id: empId, full_name: 'דנה', shift_area: null, ...extra });
  const commitment = { employee_id: empId, days: [0, 1, 2, 3].map(day => ({ day, is_off: false, start_hhmm: '07:00', end_hhmm: '16:00' })) };
  const seed = (emp) => buildSeedEntries({
    dates, employees: [emp], commitments: [commitment], activeClassroomIds: new Set(), closedDates: new Set(),
  }).map(e => e.date);

  eq(seed(mkEmp({})).length, 4, 'בלי חופשה — ארבעה ימים נזרעים');
  eq(seed(mkEmp({ on_maternity_leave: true })).length, 0, 'חופשה בלי תאריכים — אף יום לא נזרע');
  eq(seed(mkEmp({ on_maternity_leave: true, maternity_leave_to: d(1) })), [d(2), d(3)],
    'חופשה שנגמרת באמצע השבוע — נזרעים רק הימים שאחריה');
  eq(seed(mkEmp({ on_maternity_leave: true, maternity_leave_from: d(2) })), [d(0), d(1)],
    'חופשה שמתחילה באמצע השבוע — נזרעים רק הימים שלפניה');
  eq(onMaternityLeave(mkEmp({ on_maternity_leave: false }), d(0)), false, 'בלי הדגל — אין חופשה');

  console.log('\n🧹 סימון החופשה מפנה שבועות פתוחים');
  const branch = await M.Branch.create({ name: 'הרצליה הרצוג' });
  const emp = await M.Employee.create({
    full_name: 'דנה', israeli_id: '123123123', branch_id: branch._id, is_active: true,
    on_maternity_leave: true, maternity_leave_from: new Date(`${d(0)}T00:00:00Z`), maternity_leave_to: new Date(`${d(2)}T00:00:00Z`),
  });
  const other = await M.Employee.create({ full_name: 'רות', israeli_id: '321321321', branch_id: branch._id, is_active: true });
  const entry = (who, date) => ({ employee_id: who._id, employee_name: who.full_name, date, area: 'floater', start_hhmm: '07:00', end_hhmm: '16:00' });
  const wk = await M.ShiftWeek.create({
    branch_id: branch._id, week_start: dates[0],
    entries: [entry(emp, d(0)), entry(emp, d(1)), entry(emp, d(3)), entry(other, d(1))],
  });

  const removed = await svc.removeMaternityPlacements(emp.toObject());
  eq(removed, 2, 'הוסרו בדיוק שני השיבוצים שבתוך החופשה');
  const left = (await M.ShiftWeek.findById(wk._id).lean()).entries.map(e => [e.employee_name, e.date]).sort();
  eq(left, [['דנה', d(3)], ['רות', d(1)]].sort(),
    'שיבוץ ידני אחרי החופשה נשאר, ורות לא נגעה');

  await mongoose.disconnect();
  await mongod.stop();
  console.log(failures ? `\n❌ ${failures} בדיקות נכשלו\n` : '\n✅ כל הבדיקות עברו\n');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
