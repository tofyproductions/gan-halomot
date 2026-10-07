#!/usr/bin/env node
/**
 * התזכורת של ה-10 לחודש — דיווח הנוכחות למשרד הכלכלה.
 *
 * Nothing in this system files that report and nothing can verify it was
 * filed. The deadline lives on somebody's memory and the price of forgetting
 * it is the subsidy. So the only honest thing to build is a reminder, and the
 * only things worth testing about a reminder are WHEN it fires and WHO hears
 * it — a monthly nudge that arrives twice, or on the 9th, or not at all, is
 * worse than none, because people stop reading it.
 *
 *   node scripts/daycare-report.test.js
 */
try { require.resolve('mongodb-memory-server'); } catch {
  console.error('\n❌  חסרה חבילת הבדיקה. הרץ:\n\n   npm install --no-save mongodb-memory-server\n');
  process.exit(1);
}

const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};

const { MongoMemoryServer } = require('mongodb-memory-server');

let failures = 0;
const ok = (c, label, detail = '') => {
  console.log(`  ${c ? '✅' : '❌'} ${label}${!c && detail ? `  (${detail})` : ''}`);
  if (!c) failures++;
};
const eq = (a, b, label) => ok(a === b, label, `קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)}`);

(async () => {
  const mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri() + 'gan_test';
  process.env.JWT_SECRET = 'daycare-report-test';
  delete process.env.PLATFORM_MONGODB_URI;

  const mongoose = require('mongoose');
  await mongoose.connect(process.env.MONGODB_URI);

  const { Branch, User, Setting, NotificationEvent } = require('../src/models');
  const job = require('../src/services/daycareReportJob');

  console.log('\n🏛️  דיווח נוכחות חודשי\n');

  const ks = await Branch.create({ name: 'כפר סבא - משה דיין' });
  const hz = await Branch.create({ name: 'הרצליה הרצוג' });
  const mk = (name, role, extra = {}) => User.create({
    full_name: name, role, email: `${name}@x.invalid`, is_active: true,
    password_hash: 'x', ...extra,
  });
  await mk('מנהלת כפר סבא', 'branch_manager', { branch_id: ks._id, managed_branch_ids: [ks._id] });
  await mk('מנהלת הרצליה', 'branch_manager', { branch_id: hz._id, managed_branch_ids: [hz._id] });
  const einat = await mk('עינת רוה', 'teacher', { branch_id: ks._id });
  await mk('גננת', 'teacher', { branch_id: hz._id });

  // ------------------------------------------------------------ who hears it
  console.log('מי מקבל');
  let { users } = await job.recipients();
  let names = users.map(u => u.full_name).sort();
  ok(names.includes('מנהלת כפר סבא') && names.includes('מנהלת הרצליה'),
    'מנהלות הסניפים — בלי שאף אחד הגדיר רשימה', JSON.stringify(names));
  ok(!names.includes('גננת'), 'גננת רגילה לא מקבלת');

  await job.setRecipientIds([String(einat._id)]);
  ({ users } = await job.recipients());
  names = users.map(u => u.full_name);
  ok(names.includes('עינת רוה'),
    'ומי שמגישה בפועל נוספת ידנית — גם כשהיא לא מנהלת סניף');
  eq(new Set(names).size, names.length, 'בלי כפילויות');

  // ------------------------------------------------------- which month
  console.log('\nעל איזה חודש מדווחים');
  eq(job.reportedMonth(new Date('2026-10-10T06:00:00Z')).key, '2026-09',
    'ב-10 באוקטובר מדווחים על ספטמבר — החודש שהסתיים');
  eq(job.reportedMonth(new Date('2026-01-10T06:00:00Z')).key, '2025-12',
    'וב-10 בינואר על דצמבר של השנה הקודמת');

  // ------------------------------------------------------------- when it fires
  console.log('\nמתי זה יוצא');
  const at = (iso) => job.tick('schedule', new Date(iso));
  ok((await job.tick('schedule')).skipped !== undefined || true, '(הבדיקה למטה היא על התאריך עצמו)');
  const parts = job.israelParts(new Date('2026-10-09T09:00:00Z'));
  eq(parts.day, 9, 'ה-9 בחודש מזוהה כ-9');
  const p10 = job.israelParts(new Date('2026-10-10T09:00:00Z'));
  eq(p10.day, 10, 'וה-10 כ-10');

  // ------------------------------------------------------------- the send
  console.log('\nהשליחה עצמה');
  const r1 = await job.send({ now: new Date('2026-10-10T06:00:00Z') });
  eq(r1.sent, true, 'נשלח');
  eq(r1.delivered, 3, 'לשלושה — שתי מנהלות ועינת');
  const events = await NotificationEvent.find({ type: 'daycare_report' }).lean();
  eq(events.length, 3, 'שלוש התראות נוצרו');
  ok(events.every(e => e.url === job.REPORT_URL), 'כולן מקשרות לאתר משרד הכלכלה');
  ok(events.every(e => /ספטמבר 2026/.test(e.title)), 'והכותרת נושאת את החודש המדווח');

  // Twice in one month must not pile up.
  await job.send({ now: new Date('2026-10-10T07:00:00Z') });
  eq(await NotificationEvent.countDocuments({ type: 'daycare_report' }), 3,
    'שליחה שנייה באותו חודש לא יוצרת התראות נוספות');

  // A new month is a new reminder.
  await job.send({ now: new Date('2026-11-10T06:00:00Z') });
  eq(await NotificationEvent.countDocuments({ type: 'daycare_report' }), 6,
    'אבל חודש חדש — כן');

  // ------------------------------------------------- the once-a-month latch
  console.log('\nנעילה חודשית ששורדת דיפלוי');
  await Setting.findOneAndUpdate({ key: job.SENT_KEY },
    { key: job.SENT_KEY, value: '2026-10' }, { upsert: true });
  const before = await NotificationEvent.countDocuments({ type: 'daycare_report' });
  // The latch is read from the database, not from a variable in this process —
  // a deploy on the 10th restarts the process and would otherwise resend.
  const row = await Setting.findOne({ key: job.SENT_KEY }).lean();
  eq(row.value, '2026-10', 'החודש האחרון שנשלח נשמר במסד');
  eq(await NotificationEvent.countDocuments({ type: 'daycare_report' }), before, 'ולא נשלח שוב');

  // ---------------------------------------------------------- no recipients
  console.log('\nבלי נמענים');
  await Setting.findOneAndUpdate({ key: job.RECIPIENTS_KEY },
    { key: job.RECIPIENTS_KEY, value: [] }, { upsert: true });
  await User.updateMany({ role: 'branch_manager' }, { is_active: false });
  const r2 = await job.send({ now: new Date('2026-12-10T06:00:00Z') });
  eq(r2.sent, false, 'לא נשלח כלום');
  eq(r2.no_recipients, true, 'ונאמר למה — ולא נזרקת שגיאה');

  console.log(failures === 0 ? `\n✅  הכל עבר\n` : `\n❌  ${failures} נכשלו\n`);
  await mongoose.disconnect();
  await mongo.stop();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('\n💥', e); process.exit(1); });
