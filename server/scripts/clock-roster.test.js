#!/usr/bin/env node
/**
 * רענון רשימת המשתמשים בשעון — המשימה היומית ושמירת התוצאה.
 *
 * הבדיקה רצה מול מסד נתונים בזיכרון, בלי שרת HTTP: `tick` ו-`storeRoster` הן
 * שתי פונקציות מעל מונגו ולא נוגעות באימות. dotenv מוחלף ב-require.cache לפני
 * שהמודלים נטענים, כדי ששום דבר לא יקרא את server/.env — שמחזיק את פרטי
 * הפרודקשן.
 *
 *   node scripts/clock-roster.test.js
 */

/* ------------------------------------------------------------------ *
 * Nothing may read server/.env.
 * ------------------------------------------------------------------ */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let failures = 0;
let checks = 0;
function ok(cond, label, detail = '') {
  checks++;
  if (cond) console.log(`  ✅ ${label}`);
  else { failures++; console.log(`  ❌ ${label}${detail ? `  (${detail})` : ''}`); }
  return !!cond;
}
const eq = (actual, expected, label) => ok(
  JSON.stringify(actual) === JSON.stringify(expected), label,
  `קיבלנו ${JSON.stringify(actual)}, ציפינו ${JSON.stringify(expected)}`,
);
const head = (t) => console.log(`\n${t}`);

(async () => {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());

  const { Branch, AgentCommand } = require('../src/models');
  const roster = require('../src/services/clockRosterJob');

  const withClock = await Branch.create({ name: 'עם שעון', clock_ip: '10.0.0.8' });
  const alsoClock = await Branch.create({ name: 'עוד אחד עם שעון', clock_ip: '10.0.0.2' });
  const noClock = await Branch.create({ name: 'בלי שעון', clock_ip: '' });

  head('1. המשימה מזמינה קריאה רק מסניפים שיש בהם שעון');
  let r = await roster.tick();
  eq([r.branches, r.queued, r.skipped], [2, 2, 0], 'שני סניפים, שתי פקודות');
  const queued = await AgentCommand.find({ type: 'list_users' }).lean();
  eq(queued.length, 2, 'שתי פקודות list_users בתור');
  ok(!queued.some(c => String(c.branch_id) === String(noClock._id)), 'הסניף בלי שעון לא קיבל פקודה');
  // מונגו לא מחזיק מפתח למטען Mixed ריק, ולכן הוא חוזר undefined ולא {} —
  // בדיוק כמו ב-ping. המטפל בסוכן לא קורא את המטען בכלל.
  ok(!queued[0].payload || Object.keys(queued[0].payload).length === 0, 'הפקודה בלי מטען');
  eq(queued[0].status, 'pending', 'ממתינה');

  head('2. סבב שני לא מכפיל פקודה שעוד בתור');
  r = await roster.tick();
  eq([r.queued, r.skipped], [0, 2], 'אפס חדשות, שתיים דולגו');
  eq(await AgentCommand.countDocuments({ type: 'list_users' }), 2, 'עדיין שתיים בלבד');

  head('3. פקודה שהושלמה לא חוסמת את הסבב הבא');
  await AgentCommand.updateMany({ type: 'list_users' }, { $set: { status: 'confirmed' } });
  r = await roster.tick();
  eq([r.queued, r.skipped], [2, 0], 'שתיים חדשות');
  await AgentCommand.deleteMany({});

  head('4. שמירת תוצאה — ריפוד ת"ז, מיון לפי uid, סינון זבל');
  const cmd = await AgentCommand.create({
    branch_id: withClock._id, type: 'list_users', payload: {}, status: 'confirmed',
    result: {
      count: 4,
      users: [
        { uid: 7, user_id: '204635106', password: '7155', cardno: 0, role: 0 },
        // ת"ז שהמכשיר החזיר בלי האפס המוביל — חייבת להגיע מרופדת ל-9
        { uid: 2, user_id: '24317653', password: '6426', cardno: 0, role: 0 },
        // רשומה ריקה — נופלת
        { uid: 9, user_id: '', password: '', cardno: 0, role: 0 },
        { uid: 1, user_id: '328739479', password: '7277', cardno: 11909819, role: 14 },
      ],
    },
  });
  const stored = await roster.storeRoster(cmd);
  eq(stored, { stored: 3 }, 'שלוש רשומות נשמרו, הריקה נפלה');
  let b = await Branch.findById(withClock._id).lean();
  eq(b.clock_users.map(u => u.uid), [1, 2, 7], 'ממוין לפי uid');
  eq(b.clock_users.map(u => u.user_id), ['328739479', '024317653', '204635106'], 'כל ת"ז ב-9 ספרות');
  eq(b.clock_users[0].role, 14, 'התפקיד נשמר');
  eq(b.clock_users[0].cardno, 11909819, 'מספר הכרטיס נשמר');
  ok(b.clock_users_updated_at instanceof Date, 'חתימת הזמן עודכנה');

  head('5. רשימה ריקה לא מוחקת רשימה טובה');
  const before = b.clock_users.length;
  const emptyCmd = await AgentCommand.create({
    branch_id: withClock._id, type: 'list_users', payload: {}, status: 'confirmed',
    result: { count: 0, users: [] },
  });
  eq(await roster.storeRoster(emptyCmd), null, 'לא נשמר דבר');
  b = await Branch.findById(withClock._id).lean();
  eq(b.clock_users.length, before, 'הרשימה הקודמת שרדה');

  head('6. פקודה שנכשלה או מסוג אחר לא נוגעת במטמון');
  const failed = await AgentCommand.create({
    branch_id: alsoClock._id, type: 'list_users', payload: {}, status: 'failed',
    last_error: 'TIMEOUT_ON_WRITING_MESSAGE',
    result: { count: 5, users: [{ uid: 1, user_id: '111111111' }] },
  });
  eq(await roster.storeRoster(failed), null, 'כשלון לא נשמר');
  const other = await AgentCommand.create({
    branch_id: alsoClock._id, type: 'ping', payload: {}, status: 'confirmed',
    result: { pong: true },
  });
  eq(await roster.storeRoster(other), null, 'סוג אחר לא נשמר');
  eq((await Branch.findById(alsoClock._id).lean()).clock_users, [], 'המטמון של הסניף השני נשאר ריק');

  head('7. list_users הוא סוג פקודה חוקי במודל');
  const bad = new AgentCommand({ branch_id: withClock._id, type: 'not_a_command' });
  let threw = false;
  try { await bad.validate(); } catch { threw = true; }
  ok(threw, 'סוג לא מוכר נדחה');
  const good = new AgentCommand({ branch_id: withClock._id, type: 'list_users' });
  let okValidate = true;
  try { await good.validate(); } catch { okValidate = false; }
  ok(okValidate, 'list_users עובר אימות');

  head('8. clock_user_count קיים על הסניף');
  await Branch.updateOne({ _id: withClock._id }, { $set: { clock_user_count: 43 } });
  eq((await Branch.findById(withClock._id).lean()).clock_user_count, 43, 'המספר מהמכשיר נשמר');

  await mongoose.disconnect();
  await mongo.stop();

  console.log(`\n${failures ? '❌' : '✅'} ${checks - failures}/${checks} בדיקות עברו`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('\n💥', e); process.exit(1); });
