/**
 * Seeds a throwaway database with documents shaped like the real ones — real
 * names, real phone numbers, real ids — runs the scrambler over it, and then
 * asserts that not one of those originals survived anywhere in the database.
 */
/**
 * mongodb-memory-server is deliberately NOT a dependency of this package.
 * Render runs `npm install` on every deploy and would download a MongoDB
 * binary into the build of a gan that is serving families — a hundred
 * megabytes and a new way for the deploy to fail, in exchange for a package
 * only ever used on a laptop. Install it when you want to run the test:
 *
 *   npm install --no-save mongodb-memory-server
 */
try {
  require.resolve('mongodb-memory-server');
} catch {
  console.error('\n\u274C  חסרה חבילת הבדיקה. הרץ:\n\n   npm install --no-save mongodb-memory-server\n');
  process.exit(1);
}

const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient } = require('mongodb');
const { execFileSync } = require('child_process');

const PII = ['מיכל לוי', 'דוד כהן', '0521234567', '039876543', 'michal@gmail.com',
             'רחוב הרצל 15, כפר סבא', 'גן החלומות כפר סבא', 'אמונה - כפר סבא',
             'ילדה עם אלרגיה קשה לבוטנים', '123456782'];

(async () => {
  const mongod = await MongoMemoryServer.create();
  const base = mongod.getUri();
  const uri = base.replace(/\/?$/, '/ganflow_demo_test');
  const client = await MongoClient.connect(uri);
  const db = client.db('ganflow_demo_test');

  await db.collection('children').insertMany([{
    child_name: 'מיכל לוי', child_id_number: '123456782', birth_date: new Date('2021-03-14'),
    parent_name: 'דוד כהן', phone: '0521234567', email: 'michal@gmail.com',
    address: 'רחוב הרצל 15, כפר סבא', medical_alerts: 'ילדה עם אלרגיה קשה לבוטנים',
    allergies: 'בוטנים', emergency_contact: 'דוד כהן', emergency_phone: '039876543',
    monthly_fee: 2400, academic_year: 'תשפ"ו', gender: 'female',
  }]);
  await db.collection('branches').insertMany([
    { name: 'גן החלומות כפר סבא', delivery_contact_name: 'מיכל לוי', delivery_contact_phone: '0521234567', agent_secret: 'super-secret-value' },
  ]);
  await db.collection('amutas').insertMany([{ name: 'אמונה - כפר סבא', tax_id: '580123456' }]);
  await db.collection('users').insertMany([
    { email: 'michal@gmail.com', full_name: 'מיכל לוי', password_hash: '$2a$10$realhash', id_number: '123456782', salary: 12000, role: 'branch_manager' },
  ]);
  await db.collection('employees').insertMany([{
    name: 'דוד כהן', israeli_id: '123456782', phone: '0521234567',
    bank_account: '12345678', global_salary: 15000,
    notes: 'עובד מצוין, גר ברחוב הרצל 15',
    nested: { deep: { employee_name: 'מיכל לוי', contact_phone: '0521234567' } },
    history: [{ approved_by_name: 'דוד כהן', note: 'אושר על ידי מיכל לוי' }],
  }]);
  await db.collection('photos').insertMany([{ child_name: 'מיכל לוי', b64: 'AAAA', thumb_key: 'real/key.jpg' }]);

  console.log('--- לפני ---');
  console.log(JSON.stringify(await db.collection('children').findOne({}), null, 1).slice(0, 400));

  await client.close();

  const out = execFileSync('node', ['scripts/ganflow-demo-scramble.js', '--uri', uri, '--yes'],
    { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, MONGODB_URI: 'mongodb://production-not-this-one/real' } });
  console.log(out);

  const c2 = await MongoClient.connect(uri);
  const db2 = c2.db('ganflow_demo_test');
  const dump = [];
  for (const { name } of await db2.listCollections().toArray()) {
    dump.push(JSON.stringify(await db2.collection(name).find({}).toArray()));
  }
  const all = dump.join('\n');

  console.log('--- אחרי ---');
  console.log(JSON.stringify(await db2.collection('children').findOne({}), null, 1).slice(0, 500));
  console.log(JSON.stringify(await db2.collection('employees').findOne({}), null, 1).slice(0, 600));

  console.log('\n--- בדיקת דליפה ---');
  let leaked = 0;
  for (const p of PII) {
    const hit = all.includes(p);
    if (hit) leaked++;
    console.log(`  ${hit ? '❌ דלף' : '✅ נקי'}  ${p}`);
  }
  const FEMALE_POOL = ['נועה','מאיה','שירה','תמר','יעל','אביגיל','ליאן','רוני','אלה','הילה','דנה','מירי','אורית','גלית','סיון','עדי','רותם','נטע','אורלי','ליבי','טליה','שקד','אמה','אריאל','לוטם','אגם','יערה','כרמל','שני','מיכל'];
  const child = await db2.collection('children').findOne({});
  const genderOk = FEMALE_POOL.includes(String(child.child_name).split(' ')[0]);
  console.log(`  ${genderOk ? '✅' : '❌'} שם תואם מין (נקבה → ${child.child_name})`);

  const photos = await db2.collection('photos').countDocuments();
  console.log(`  ${photos === 0 ? '✅' : '❌'} תמונות נמחקו (${photos} נותרו)`);
  const secret = all.includes('super-secret-value');
  console.log(`  ${secret ? '❌' : '✅'} סוד הסוכן נמחק`);

  const pass = leaked === 0 && photos === 0 && !secret && genderOk;
  console.log(pass ? '\n🎉 עבר\n' : `\n💥 נכשל — ${leaked} דליפות\n`);

  await c2.close();
  await mongod.stop();
  process.exit(pass ? 0 : 1);
})();
