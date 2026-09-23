/**
 * מחיקת התמונות אחרי שנתיים — הפעולה היחידה כאן שאי אפשר לבטל.
 *
 * Three properties matter, and each of them is the kind that is only noticed
 * once it is too late:
 *
 *   THE BOUNDARY. A photograph from תשפ"ז must survive all of תשפ"ח and go at
 *   the start of תשפ"ט. Off by one year in either direction is either a broken
 *   promise to a family or a gan paying to store photographs of children who
 *   left two years ago.
 *
 *   IT CANNOT REACH A CONTRACT. Photographs, scanned contracts, ID copies and
 *   payslips share one bucket, and only the photographs are scoped to years.
 *   The job walks the Photo collection and deletes the keys those rows name —
 *   it never lists the bucket — so a contract is unreachable by construction
 *   rather than by a rule somebody has to remember.
 *
 *   THE CAP ALERTS, NEVER DELETES. A ceiling that deletes is a ceiling that
 *   decides, one busy month, to remove photographs a family was promised.
 */
const assert = require('assert');

const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

const failures = [];
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

(async () => {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'retention' });

  // Storage, watched rather than mocked away: the point of this test is which
  // keys are asked for, and a contract's key appearing here would be the bug.
  const deleted = [];
  const storagePath = require.resolve('../src/services/storage.service');
  require.cache[storagePath] = {
    id: storagePath, filename: storagePath, loaded: true, children: [], paths: [],
    exports: {
      isConfigured: () => true,
      deleteObject: async (key) => { deleted.push(key); },
      getObject: async () => Buffer.alloc(0),
      putObject: async () => {},
    },
  };
  const emailPath = require.resolve('../src/services/email.service');
  const mails = [];
  require.cache[emailPath] = {
    id: emailPath, filename: emailPath, loaded: true, children: [], paths: [],
    exports: { dispatchEmail: async (m) => { mails.push(m); } },
  };

  const job = require('../src/services/photoRetentionJob');
  const { Photo, Setting } = require('../src/models');

  console.log('גבול השנתיים:');

  // "Now" is mid-תשפ"ט (January 2029). תשפ"ז ran Sept 2026 – Aug 2027.
  const now = new Date('2029-01-15T10:00:00Z');
  check('הגבול מחושב נכון', job.cutoffDate(now) === '2027-09-01', job.cutoffDate(now));
  check('  לפני ספטמבר השנה נספרת אחורה',
    job.cutoffDate(new Date('2028-06-01')) === '2026-09-01',
    job.cutoffDate(new Date('2028-06-01')));
  check('  ואחרי ספטמבר קדימה',
    job.cutoffDate(new Date('2028-09-02')) === '2027-09-01',
    job.cutoffDate(new Date('2028-09-02')));

  const mk = (date, key) => Photo.create({
    key, thumb_key: `${key}.thumb`, source: 'staff', date, bytes: 300000,
  });
  const old1 = await mk('2027-03-10', 'photos/old-a.jpg');     // תשפ"ז — goes
  const old2 = await mk('2027-08-31', 'photos/old-b.jpg');     // last day of תשפ"ז — goes
  const keep1 = await mk('2027-09-01', 'photos/keep-a.jpg');   // first day of תשפ"ח — stays
  const keep2 = await mk('2028-12-01', 'photos/keep-b.jpg');   // this year — stays

  const r = await job.tick(now);

  console.log('');
  console.log('מה נמחק:');
  check('שתי הישנות נמחקו', r.deleted === 2, `נמחקו ${r.deleted}`);
  check('  ומהאחסון גם המוקטנת', deleted.includes('photos/old-a.jpg') && deleted.includes('photos/old-a.jpg.thumb'));
  check('היום האחרון של השנה הישנה נמחק', !(await Photo.findById(old2)));
  check('היום הראשון של השנה שאחריה נשאר', Boolean(await Photo.findById(keep1)));
  check('  וגם השנה הנוכחית', Boolean(await Photo.findById(keep2)));
  check('  ושום מפתח שאינו תמונה לא נגע',
    deleted.every((k) => k.startsWith('photos/')), deleted.join(', '));
  check('  ולא נגענו בשורות שנשארו', (await Photo.countDocuments()) === 2);

  console.log('');
  console.log('כשהאחסון נכשל:');
  const before = await Photo.countDocuments();
  await mk('2026-10-01', 'photos/broken.jpg');
  const good = require.cache[storagePath].exports.deleteObject;
  require.cache[storagePath].exports.deleteObject = async () => { throw new Error('bucket down'); };
  const r2 = await job.tick(now);
  require.cache[storagePath].exports.deleteObject = good;
  check('השורה שורדת שגיאת אחסון', (await Photo.countDocuments()) === before + 1,
    'אחרת הבייטים מתייתמים לנצח ואיש לא יודע שהם שם');
  check('  והכשלון מדווח', r2.failed === 1, JSON.stringify(r2));
  await Photo.deleteOne({ key: 'photos/broken.jpg' });

  console.log('');
  console.log('התקרה:');
  await Setting.updateOne({ key: job.CAP_KEY },
    { $set: { key: job.CAP_KEY, value: { gb: 0.0000001 } } }, { upsert: true });
  await Setting.updateOne({ key: 'face_alert_email' },
    { $set: { key: 'face_alert_email', value: { email: 'amit@example.com' } } }, { upsert: true });
  const countBefore = await Photo.countDocuments();
  const r3 = await job.tick(now);
  check('חציית התקרה מתריעה', r3.cap.over === true && mails.length === 1, JSON.stringify(r3.cap));
  check('  ולא מוחקת כלום', (await Photo.countDocuments()) === countBefore);
  check('  וההודעה אומרת שלא נמחק כלום',
    Boolean(mails[0] && mails[0].text.includes('לא נמחק')));

  await job.tick(now);
  check('  ולא חוזרת על עצמה כל יום', mails.length === 1, `${mails.length} הודעות`);

  console.log('');
  console.log('ילד שעזב:');
  const { Child, ChildFaceReference } = require('../src/models');
  const stays = await Child.create({
    registration_id: new mongoose.Types.ObjectId(),
    child_name: 'נשאר', academic_year: '2026-2027', is_active: true,
  });
  const left = await Child.create({
    registration_id: new mongoose.Types.ObjectId(),
    child_name: 'עזב', academic_year: '2026-2027', is_active: false,
  });
  for (const c of [stays, left]) {
    await ChildFaceReference.create({
      child_id: c._id, embedding: [1, 0, 0], source: 'staff',
    });
  }
  const forgotten = await job.forgetDepartedChildren();
  check('הטביעה של מי שעזב נמחקת', forgotten === 1, `נמחקו ${forgotten}`);
  check('  ושל מי שנשאר לא',
    (await ChildFaceReference.countDocuments({ child_id: stays._id })) === 1);
  check('  ואין לו יותר שום מידע ביומטרי',
    (await ChildFaceReference.countDocuments({ child_id: left._id })) === 0);
  // The memories are the family's; only the template goes.
  check('  אבל התמונות עצמן לא נגעו', (await Photo.countDocuments()) > 0);

  await mongoose.disconnect();
  await mongod.stop();

  if (failures.length) { console.error(`\nFAIL — ${failures.length} שגויים`); process.exit(1); }
  console.log('\nPASS face-retention');
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
