#!/usr/bin/env node
/**
 * Publishing the year into every branch.
 *
 * The import writes to two different collections and has to be safe to run
 * again — the obvious way to fix a typo in the published list is to correct
 * the source and re-run it. So:
 *
 *   - each row lands in the right collection (money: one draws a vacation day,
 *     the other does not)
 *   - a second run updates rather than duplicating
 *   - a row the office edited by hand survives the next import
 *   - every branch gets the year, not just the first
 *
 * The last one sounds obvious and is exactly the kind of thing a loop gets
 * wrong once and nobody notices until a branch turns up open on פסח.
 *
 *   npm install --no-save mongodb-memory-server
 *   node scripts/vacation-import-api.test.js
 */
try { require.resolve('mongodb-memory-server'); } catch {
  console.error('\n❌  חסרה חבילת הבדיקה. הרץ:\n\n   npm install --no-save mongodb-memory-server\n');
  process.exit(1);
}

const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient, ObjectId } = require('mongodb');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');

const PORT = 5425;
const B = `http://localhost:${PORT}`;
const SECRET = 'vacation-import-secret';
// The year is asked for BY ITS HEBREW NAME and must be stored under the
// Gregorian range — the shape Classroom, Child and Holiday all use. Keying it
// by the Hebrew name is the bug that made the import refuse every branch.
const YEAR_REQUESTED = 'תשפ״ז';
const YEAR = '2026-2027';
let failures = 0;

const ok = (cond, label) => { console.log(`  ${cond ? '✅' : '❌'} ${label}`); if (!cond) failures++; };
const eq = (a, b, label) => {
  const good = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  ${good ? '✅' : '❌'} ${label}${good ? '' : `  (קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)})`}`);
  if (!good) failures++;
};

async function api(pathname, { token, method = 'GET', body } = {}) {
  const res = await fetch(B + pathname, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null; try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}

const waitForServer = async (ms = 60000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await fetch(`${B}/api/health`); if (r.status < 500) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
};
async function portIsFree() {
  try { await fetch(`${B}/api/health`, { signal: AbortSignal.timeout(1500) }); return false; }
  catch { return true; }
}

(async () => {
  if (!await portIsFree()) {
    console.error(`\n❌  משהו כבר מאזין על ${PORT}:\n\n   lsof -nP -iTCP:${PORT} -sTCP:LISTEN -t | xargs kill -9\n`);
    process.exit(1);
  }

  const mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri('gan_vacations_test');
  const client = await MongoClient.connect(uri);
  const db = client.db('gan_vacations_test');

  const amutaId = new ObjectId();
  const branchA = new ObjectId();
  const branchB = new ObjectId();
  await db.collection('amutas').insertOne({ _id: amutaId, name: 'עמותת בדיקה' });
  await db.collection('branches').insertMany([
    { _id: branchA, name: 'כפר סבא', amuta_id: amutaId },
    { _id: branchB, name: 'הרצליה', amuta_id: amutaId },
  ]);
  await client.close();

  const admin = jwt.sign({ id: String(new ObjectId()), full_name: 'מנהל', role: 'system_admin' },
    SECRET, { expiresIn: '1h' });

  const srv = spawn('node', ['src/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, MONGODB_URI: uri, JWT_SECRET: SECRET, PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  srv.stdout.on('data', (d) => log.push(String(d)));
  srv.stderr.on('data', (d) => log.push(String(d)));
  const done = (code) => { try { srv.kill('SIGKILL'); } catch { /* gone */ } mongo.stop().finally(() => process.exit(code)); };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => done(1));
  process.on('exit', () => { try { srv.kill('SIGKILL'); } catch { /* gone */ } });

  if (!await waitForServer()) { console.error('❌  השרת לא עלה\n' + log.join('')); return done(1); }

  const counts = async () => {
    const c = await MongoClient.connect(uri);
    const d = c.db('gan_vacations_test');
    const out = {
      holidays: await d.collection('holidays').countDocuments({ academic_year: YEAR }),
      specials: await d.collection('specialdays').countDocuments({ academic_year: YEAR }),
      shortDays: await d.collection('holidays').countDocuments({ academic_year: YEAR, kind: 'short_day' }),
    };
    await c.close();
    return out;
  };

  try {
    console.log('\n📤  ייבוא ראשון — כל סניף מקבל את השנה\n');
    {
      const r = await api('/api/holidays/import-year', { token: admin, method: 'POST', body: { academic_year: YEAR_REQUESTED } });
      eq(r.status, 200, 'הייבוא הצליח — גם כשמבקשים בשם העברי');
      eq(r.json?.academic_year, YEAR, 'ונשמר תחת הטווח הלועזי שכל המערכת משתמשת בו');
      eq((r.json?.branches || []).length, 2, 'שני הסניפים טופלו');
      ok((r.json?.branches || []).every((b) => b.created > 0), 'ובשניהם נוצרו שורות');

      const c = await counts();
      // 13 published rows: 10 land in Holiday (8 closures + 2 short days),
      // 3 land in SpecialDay. Times two branches.
      eq(c.holidays, 20, '20 חופשות (10 שורות × 2 סניפים)');
      eq(c.specials, 6, '6 ימים מיוחדים (3 שורות × 2 סניפים)');
      eq(c.shortDays, 4, 'ומתוכן 4 ימים מקוצרים (2 × 2)');
    }

    console.log('\n🔁  ייבוא שני — מעדכן, לא מכפיל\n');
    {
      const r = await api('/api/holidays/import-year', { token: admin, method: 'POST', body: { academic_year: YEAR } });
      eq(r.status, 200, 'הייבוא החוזר הצליח');
      ok((r.json?.branches || []).every((b) => b.created === 0), 'ולא נוצרה אף שורה חדשה');

      const c = await counts();
      eq(c.holidays, 20, 'עדיין 20 חופשות');
      eq(c.specials, 6, 'ועדיין 6 ימים מיוחדים');
    }

    console.log('\n✋  שורה שנערכה ידנית שורדת ייבוא\n');
    {
      const c1 = await MongoClient.connect(uri);
      await c1.db('gan_vacations_test').collection('holidays').updateOne(
        { branch_id: branchA, name: 'פסח' },
        { $set: { is_custom: true, name: 'פסח (שונה ידנית)' } },
      );
      await c1.close();

      await api('/api/holidays/import-year', { token: admin, method: 'POST', body: { academic_year: YEAR } });

      const c2 = await MongoClient.connect(uri);
      const edited = await c2.db('gan_vacations_test').collection('holidays')
        .findOne({ branch_id: branchA, is_custom: true });
      const pesachRows = await c2.db('gan_vacations_test').collection('holidays')
        .countDocuments({ branch_id: branchA, start_date: new Date('2027-04-19T00:00:00.000Z') });
      await c2.close();

      eq(edited?.name, 'פסח (שונה ידנית)', 'העריכה הידנית נשמרה');
      eq(pesachRows, 1, 'ולא נוצרה שורה כפולה לצידה');
    }

    console.log('\n📅  הלוח המאוחד נקרא נכון\n');
    {
      const r = await api(`/api/holidays/calendar?branch=${branchB}&year=${encodeURIComponent(YEAR)}`, { token: admin });
      eq(r.status, 200, 'הלוח נטען');
      const entries = r.json?.entries || [];
      eq(entries.length, 13, '13 שורות — חופשות וימים מיוחדים יחד');

      const dates = entries.map((e) => e.start);
      eq(dates, [...dates].sort(), 'ומסודרות לפי תאריך');

      const zikaron = entries.find((e) => e.name === 'יום הזיכרון');
      eq(zikaron?.kind, 'short_day', 'יום הזיכרון מסומן כיום מקוצר');
      eq(zikaron?.end_time, '12:00', 'עם שעת הסיום');

      const graduation = entries.find((e) => e.name === 'מסיבת סיום הגן');
      eq(graduation?.kind, 'employer', 'מסיבת סיום מסומנת כסגירת מעסיק');

      ok(!!r.json?.footer, 'והערת השוליים מגיעה');
      eq(entries.find((e) => e.name === 'פסח')?.return_note, 'חזרה לגן: יום חמישי, 29.4',
        'ויום החזרה מוצג כמו שפורסם');
    }
  } catch (err) {
    console.error('💥 ', err);
    failures++;
  }

  console.log(`\n${failures ? `❌  ${failures} בדיקות נכשלו\n` : '✅  הכל עבר\n'}`);
  done(failures ? 1 : 0);
})();
