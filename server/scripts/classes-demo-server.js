/**
 * A throwaway server + database for looking at מעקב חוגים in a real browser.
 *
 * Same shape as scripts/viewer-demo-server.js: an in-memory MongoDB, a seed
 * invented from nothing, then the real src/index.js on :3001. server/.env is
 * never read — MONGODB_URI and friends are set before anything requires it —
 * and DISABLE_JOBS=1, because this process must not read a mailbox, write a
 * Google Sheet or spend money on an AI scan against whatever it is pointed at.
 *
 * The seed is built so that every screen has something to show WITHOUT anyone
 * having to click through a month first:
 *   — a provider registered for VAT who takes three groups at one branch on
 *     one morning, and a fourth at another branch;
 *   — a VAT-exempt provider with one group;
 *   — sessions already answered in the current month, so the payment summary
 *     has numbers in it, including one partial;
 *   — and a visit DUE RIGHT NOW, so the popup opens on load. That one is the
 *     whole reason this script exists: the popup only appears when a session's
 *     time has passed, which is not something you can arrange by hand.
 *
 * Usage: node scripts/classes-demo-server.js
 *        then `npm run dev:client` and log in with the line it prints.
 */
const { MongoMemoryServer } = require('mongodb-memory-server');
const bcrypt = require('bcryptjs');

const DEMO_PASSWORD = 'demo1234';
const MANAGER = { full_name: 'רונית מנהלת', id_number: '900000001' };

const ymd = (d) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });

async function main() {
  const mongod = await MongoMemoryServer.create({ instance: { dbName: 'gan_classes_demo' } });
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_SECRET = 'classes-demo-secret';
  process.env.DISABLE_JOBS = '1';
  process.env.PORT = process.env.PORT || '3001';
  process.env.FRONTEND_URL = 'http://localhost:5173';

  const mongoose = require('mongoose');
  await mongoose.connect(process.env.MONGODB_URI);
  const info = await seed();
  await mongoose.disconnect();

  console.log(`\nמסד ההדגמה נזרע. מפעיל שרת על :${process.env.PORT} ...`);
  require('../src/index.js');

  console.log('\n--- כניסה ---');
  console.log(`  שם מלא: ${MANAGER.full_name}   ת"ז: ${MANAGER.id_number}   סיסמה: ${DEMO_PASSWORD}`);
  console.log('  (POST /api/auth/login-password — לא נדרש קוד, לחשבון יש סיסמה)');
  console.log(`\n  סניפים: ${info.branches.join(' · ')}`);
  console.log(`  ביקור שממתין לתשובה עכשיו: ${info.dueCount} כיתות`);
}

async function seed() {
  const {
    User, Branch, Classroom, ClassProvider, ClassProgram, ClassSession,
  } = require('../src/models');

  const ks = await Branch.create({ name: 'כפר סבא - משה דיין' });
  const hz = await Branch.create({ name: 'הרצליה הרצוג' });
  const YEAR = '2026-2027';
  for (const [b, cat] of [[ks, 'תינוקייה'], [ks, 'צעירים'], [ks, 'בוגרים'], [hz, 'צעירים']]) {
    await Classroom.create({ name: `${cat} — ${b.name}`, branch_id: b._id, category: cat, academic_year: YEAR });
  }

  await User.create({
    ...MANAGER,
    email: 'ronit@demo.invalid',
    password_hash: await bcrypt.hash(DEMO_PASSWORD, 10),
    password_set: true,
    role: 'system_admin',
    is_active: true,
    branch_id: ks._id,
  });

  const orian = await ClassProvider.create({
    name: 'אוריאן להב', field: 'מוזיקה ותנועה', phone: '0543385436',
    branch_ids: [ks._id, hz._id], vat_mode: 'registered',
  });
  const litaf = await ClassProvider.create({
    name: 'ליטף', field: 'חוג חיות', phone: '0508860101',
    branch_ids: [ks._id], vat_mode: 'exempt',
  });

  const mk = (provider, branch, cat, day, time, rate, name, instructor) =>
    ClassProgram.create({
      branch_id: branch._id, provider_id: provider._id, name, instructor_name: instructor,
      classroom_category: cat, default_day: day, default_time: time, default_rate: rate,
    });

  // One morning, three groups, two rates — the shape the old spreadsheet
  // could not settle group by group.
  const pTinok = await mk(orian, ks, 'תינוקייה', 2, '09:00', 180, 'תנועה', 'אוריאן');
  const pTzeir = await mk(orian, ks, 'צעירים', 2, '09:30', 360, 'תנועה', 'אוריאן');
  const pBoger = await mk(orian, ks, 'בוגרים', 2, '10:00', 360, 'תנועה', 'אוריאן');
  await mk(orian, hz, 'צעירים', 4, '09:00', 300, 'תנועה', 'אוריאן');
  const pHayot = await mk(litaf, ks, 'תינוקייה', 3, '09:00', 180, 'חוג חיות', 'מור');

  const today = new Date();
  const back = (n) => { const d = new Date(today); d.setDate(d.getDate() - n); return ymd(d); };

  // Already answered, so the money panel is not empty on first load.
  const answered = [
    [pTinok, back(14), 'occurred', null],
    [pTzeir, back(14), 'occurred', null],
    [pBoger, back(14), 'partial', 180],
    [pTinok, back(7), 'occurred', null],
    [pTzeir, back(7), 'occurred', null],
    [pBoger, back(7), 'no_show', null],
    [pHayot, back(6), 'occurred', null],
  ];
  for (const [p, date, status, amount] of answered) {
    await ClassSession.create({
      program_id: p._id, branch_id: p.branch_id, date, time: p.default_time,
      rate: p.default_rate, status,
      partial_amount: amount,
      manager_confirmed: true, answered_by_manager: true, responded_at: new Date(),
    });
  }

  // DUE NOW — three groups of one visit, timed just before this minute so the
  // popup opens the moment the page loads.
  const dueDate = ymd(today);
  const dueTime = '00:01';
  for (const p of [pTinok, pTzeir, pBoger]) {
    await ClassSession.create({
      program_id: p._id, branch_id: p.branch_id, date: dueDate, time: dueTime,
      rate: p.default_rate, status: 'scheduled',
    });
  }

  return { branches: [ks.name, hz.name], dueCount: 3 };
}

main().catch((e) => { console.error('\n💥', e); process.exit(1); });
