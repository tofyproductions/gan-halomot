#!/usr/bin/env node
/**
 * ימי ההולדת של החודש, ולמי מותר להדפיס כרטיס.
 *
 * Two things are being guarded, and only one of them is cosmetic.
 *
 * The list: the gan has kept this on a wall calendar for years, which means
 * it is wrong from the first day a child leaves and nobody rubs them out.
 * A list taken from the records is only better than the calendar if it
 * excludes what the records already mark as gone — last year's enrolments and
 * the four test families, one per branch, which otherwise get a card each.
 *
 * The card: its child id arrives from the browser, and it is the only place
 * in this feature where a number typed into a URL picks a record. A branch
 * manager who edits it must not print a card carrying another branch's
 * child's name — so the lookup is constrained to the rooms the caller may
 * see, and an id outside them is "not found" rather than a card.
 *
 *   node scripts/graphics-birthdays.test.js
 */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let failures = 0;
let checks = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (cond) console.log(`  ✅ ${label}`);
  else { failures++; console.log(`  ❌ ${label}${detail ? `  (${detail})` : ''}`); }
};
const eq = (a, b, label) => ok(
  JSON.stringify(a) === JSON.stringify(b), label,
  `${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`,
);
const head = (t) => console.log(`\n${t}`);

(async () => {
  console.log('=== הגרפיקות שלנו — ימי הולדת והרשאות ===');

  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  const M = require('../src/models');
  const { birthdays, childForCard } = require('../src/services/graphics.service');

  const YEAR = 'תשפ"ו';
  const kfar = await M.Branch.create({ name: 'כפר סבא - משה דיין', is_active: true });
  const tlv = await M.Branch.create({ name: 'כפר סבא - ויצמן', is_active: true });
  const roomA = await M.Classroom.create({ name: 'תינוקיה', branch_id: kfar._id, academic_year: YEAR });
  const roomB = await M.Classroom.create({ name: 'בוגרים', branch_id: tlv._id, academic_year: YEAR });

  const reg = await M.Registration.create({
    unique_id: 'REG-1', child_name: 'הרישום', parent_name: 'הורה', monthly_fee: 2500,
    start_date: new Date('2025-09-01'), end_date: new Date('2026-07-31'), academic_year: YEAR,
  });
  let seq = 0;
  const kid = (name, room, birth, extra = {}) => M.Child.create({
    registration_id: reg._id,
    child_name: name,
    classroom_id: room._id,
    birth_date: birth ? new Date(birth) : null,
    academic_year: YEAR,
    is_active: true,
    child_id_number: String(300000000 + seq++),
    ...extra,
  });

  // March birthdays, in a deliberately unsorted order.
  const noam = await kid('נועם כהן', roomA, '2021-03-14T00:00:00Z', { gender: 'boy' });
  const shira = await kid('שירה לוי', roomA, '2022-03-02T00:00:00Z', { gender: 'girl' });
  const other = await kid('דני מזרחי', roomB, '2021-03-20T00:00:00Z');
  // Everything that must NOT appear.
  await kid('אפריל', roomA, '2021-04-05T00:00:00Z');
  await kid('בלי תאריך', roomA, null);
  await kid('ילד בדיקה', roomA, '2021-03-09T00:00:00Z', { is_test_account: true });
  await kid('עזב', roomA, '2021-03-11T00:00:00Z', { is_active: false });

  /* ---------------------------------------------------------------- */
  head('1. רשימת החודש');
  const all = await birthdays({ branchIds: null, month: 3, year: 2026 });
  eq(all.children.map(c => c.full_name), ['שירה לוי', 'נועם כהן', 'דני מזרחי'],
    'רק ילדי מרץ, מסודרים לפי יום בחודש');
  eq(all.children.map(c => c.day), [2, 14, 20], 'והיום בחודש נכון');
  eq(all.children.map(c => c.first_name), ['שירה', 'נועם', 'דני'], 'ושם פרטי נחתך מהשם המלא');
  eq(all.children.map(c => c.age), [4, 5, 5], 'והגיל שימלאו השנה');
  eq([...new Set(all.children.map(c => c.branch))].sort(),
    ['כפר סבא - ויצמן', 'כפר סבא - משה דיין'], 'וכל ילד עם הסניף שלו');

  head('2. מי לא ברשימה');
  const names = all.children.map(c => c.full_name);
  ok(!names.includes('אפריל'), 'יום הולדת בחודש אחר — לא');
  ok(!names.includes('בלי תאריך'), 'בלי תאריך לידה ברישום — לא');
  ok(!names.includes('ילד בדיקה'), 'חשבון בדיקה — לא');
  ok(!names.includes('עזב'), 'רישום לא פעיל — לא');

  head('3. הגבלת סניף');
  const onlyKfar = await birthdays({ branchIds: [String(kfar._id)], month: 3, year: 2026 });
  eq(onlyKfar.children.map(c => c.full_name), ['שירה לוי', 'נועם כהן'],
    'סניף אחד — רק הילדים שלו');
  ok(!onlyKfar.children.some(c => c.full_name === 'דני מזרחי'),
    'וילד מסניף אחר אינו מופיע');

  /* ---------------------------------------------------------------- */
  head('4. כרטיס — הילד שמותר, והילד שלא');
  const mine = await childForCard({ branchIds: [String(kfar._id)], childId: String(noam._id) });
  eq([mine?.first_name, mine?.full_name, mine?.gender], ['נועם', 'נועם כהן', 'boy'],
    'ילד מהסניף שלי — שם פרטי, שם מלא ומגדר');

  // The whole point: the id came from the browser and belongs to another gan.
  const theirs = await childForCard({ branchIds: [String(kfar._id)], childId: String(other._id) });
  ok(theirs === null, 'ילד מסניף אחר — לא נמצא, גם כשהמזהה נכון');

  const admin = await childForCard({ branchIds: null, childId: String(other._id) });
  ok(admin?.full_name === 'דני מזרחי', 'הנהלה (בלי הגבלת סניף) — כן רואה אותו');

  const missing = await childForCard({ branchIds: null, childId: new mongoose.Types.ObjectId() });
  ok(missing === null, 'מזהה שלא קיים — לא נמצא, בלי קריסה');

  /* ---------------------------------------------------------------- */
  head('5. נקודת הקצה של הכרטיס');
  const ctrl = require('../src/controllers/graphics.controller');
  const mkRes = () => ({
    code: 200, body: null, headers: {},
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
    set(k, v) { this.headers[k] = v; return this; },
    send(b) { this.body = b; return this; },
  });

  const res = mkRes();
  await ctrl.birthdayCard(
    { query: { child: String(other._id), name: 'first' }, branchScope: [String(kfar._id)] },
    res,
  );
  // 404 and not 403 on purpose: a manager probing ids must not learn which
  // of them are real children at another branch.
  eq([res.code, res.body?.error], [404, 'הילד/ה לא נמצא'],
    'בקשת כרטיס לילד מחוץ להרשאה — 404, בלי לרמוז שהילד קיים');

  const res2 = mkRes();
  await ctrl.birthdayList(
    { query: { month: '99', year: '2026' }, branchScope: null },
    res2, (e) => { res2.code = 500; res2.body = { error: String(e) }; },
  );
  eq([res2.code, res2.body?.error], [400, 'חודש לא תקין'], 'חודש לא תקין — 400');

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} עברו\n`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => { console.error('\n❌ נפילה:', err); process.exit(1); });
