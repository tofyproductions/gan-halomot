#!/usr/bin/env node
/**
 * The recruitment digest reaches somebody for every branch, with or without the
 * override table.
 *
 * WHAT THIS IS GUARDING. `branch_manager_emails` is a Setting holding one
 * address per branch, typed in by hand. It exists only because most manager
 * logins carry the synthetic `<ת"ז>@gan-halomot.local` handle instead of an
 * address, so somebody worked around that by listing the real addresses here.
 *
 * The job treated a branch with no row as a branch to SKIP — `continue`, no
 * mail, no note, nothing in the log. That made an "override" table a REQUIRED
 * one: empty it, or add a fifth branch and forget to type its address, and the
 * digest silently stops for it. Nobody notices until a candidate has waited
 * three weeks for a call.
 *
 * That matters right now because the plan is to delete the table once the
 * managers have real addresses. Deleting it before this fallback existed would
 * have turned off recruitment digests for all four branches at once, quietly.
 *
 * So: an override still wins where one is set, and where none is set the job
 * asks who runs the branch — falling back to the office when nobody there is
 * reachable, exactly as every other branch notification now does.
 *
 *   npm install --no-save mongodb-memory-server
 *   node scripts/recruitment-digest-recipients.test.js
 */
try { require.resolve('mongodb-memory-server'); } catch {
  console.error('\n❌  חסרה חבילת הבדיקה. הרץ:\n\n   npm install --no-save mongodb-memory-server\n');
  process.exit(1);
}

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const { ObjectId } = mongoose.Types;

let failures = 0;
const ok = (cond, label) => { console.log(`  ${cond ? '✅' : '❌'} ${label}`); if (!cond) failures++; };
const eq = (a, b, label) => {
  const good = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  ${good ? '✅' : '❌'} ${label}${good ? '' : `  (קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)})`}`);
  if (!good) failures++;
};

const HERZLIYA = new ObjectId();
const MOSHE_DAYAN = new ObjectId();

(async () => {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri('gan_digest_test'), { dbName: 'gan_digest_test' });
  const db = mongoose.connection.db;

  await db.collection('branches').insertMany([
    { _id: HERZLIYA, name: 'הרצליה הרצוג', is_active: true },
    { _id: MOSHE_DAYAN, name: 'כפר סבא - משה דיין', is_active: true },
  ]);

  // The office, so the last-resort fallback has somewhere to land.
  await db.collection('users').insertOne({
    _id: new ObjectId(), full_name: 'בן כהן', email: 'ben@example.com',
    role: 'system_admin', is_active: true,
  });

  // One manager with a real address, one with only a login handle — the two
  // states production is actually in.
  await db.collection('users').insertMany([
    {
      _id: new ObjectId(), full_name: 'טניה אהרון', email: 'tanya@dreamgan.com',
      role: 'branch_manager', managed_branch_ids: [HERZLIYA], is_active: true,
    },
    {
      _id: new ObjectId(), full_name: 'לידור כהן', email: '313163412@gan-halomot.local',
      role: 'branch_manager', managed_branch_ids: [MOSHE_DAYAN], is_active: true,
    },
  ]);

  // A candidate due for a call in each branch, so each has something to report.
  const due = new Date(Date.now() - 3600000);
  await db.collection('candidates').insertMany([
    {
      _id: new ObjectId(), full_name: 'מועמדת א', phone: '0501111111',
      branch_ids: [HERZLIYA], status: 'new', next_action_at: due,
    },
    {
      _id: new ObjectId(), full_name: 'מועמדת ב', phone: '0502222222',
      branch_ids: [MOSHE_DAYAN], status: 'new', next_action_at: due,
    },
  ]);

  const job = require('../src/services/recruitmentDigestJob');
  const addressesOf = (res) => res.sent
    .filter(s => s.branches !== 'משרד')
    .flatMap(s => s.to.split(',').map(x => x.trim()))
    .sort();

  console.log('\n📋  כשיש עקיפה — היא גוברת\n');
  {
    await db.collection('settings').updateOne(
      { key: 'branch_manager_emails' },
      { $set: { key: 'branch_manager_emails', value: {
        [String(HERZLIYA)]: 'override@example.com',
        [String(MOSHE_DAYAN)]: 'override@example.com',
      } } },
      { upsert: true },
    );
    const res = await job.send({ dryRun: true });
    eq(addressesOf(res), ['override@example.com'], 'שתי הסניפים הולכים לכתובת שבטבלה');
    ok(!addressesOf(res).includes('tanya@dreamgan.com'), 'והמנהלת האמיתית לא מקבלת כפילות');
  }

  console.log('\n🗑  כשהטבלה ריקה — זה מה שהיה מת בשקט\n');
  {
    await db.collection('settings').updateOne(
      { key: 'branch_manager_emails' }, { $set: { value: {} } },
    );
    const res = await job.send({ dryRun: true });
    const to = addressesOf(res);
    ok(to.length > 0, 'הדוח עדיין נשלח — לפני התיקון כאן לא היה כלום');
    ok(to.includes('tanya@dreamgan.com'), 'הרצליה מגיעה למנהלת עצמה');
    ok(to.includes('ben@example.com'), 'ומשה דיין, שלמנהלת שלו אין כתובת, מגיע למשרד');
    ok(!to.some(a => a.endsWith('@gan-halomot.local')), 'ואף ידית התחברות לא נכנסה לרשימה');
  }

  console.log('\n🧩  עקיפה חלקית — רק סניף אחד בטבלה\n');
  {
    await db.collection('settings').updateOne(
      { key: 'branch_manager_emails' },
      { $set: { value: { [String(MOSHE_DAYAN)]: 'kfar@example.com' } } },
    );
    const res = await job.send({ dryRun: true });
    const to = addressesOf(res);
    ok(to.includes('kfar@example.com'), 'הסניף שבטבלה הולך לשם');
    ok(to.includes('tanya@dreamgan.com'), 'והסניף שלא — למנהלת שלו');
    eq(to.length, 2, 'שתי כתובות, בלי כפילות');
  }

  console.log('\n🔕  סניף בלי מועמדים לא מייצר דוח ריק\n');
  {
    await db.collection('candidates').deleteMany({ branch_ids: HERZLIYA });
    const res = await job.send({ dryRun: true });
    ok(!addressesOf(res).includes('tanya@dreamgan.com'), 'אין למי לכתוב עליו — אין מייל');
  }

  console.log(failures ? `\n❌  ${failures} כשלונות\n` : '\n✅  הכל עבר\n');
  await mongoose.disconnect();
  await mongo.stop();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('\n❌  נפילה:', e.message, '\n', e.stack); process.exit(1); });
