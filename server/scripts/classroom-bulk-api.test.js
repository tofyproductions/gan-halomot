#!/usr/bin/env node
/**
 * Opening a year's classrooms across a network, through the endpoints.
 *
 * The unit suite proves which rooms get planned. This proves the part that
 * writes, and writing across every branch at once is where the damage would
 * be:
 *
 *   - the preview must NOT write. A preview that writes is a confirmation
 *     dialog that has already happened.
 *   - every branch asked for gets its rooms, not just the first
 *   - running it twice creates nothing the second time
 *   - a year somebody has already started arranging is added to, never reset
 *
 *   npm install --no-save mongodb-memory-server
 *   node scripts/classroom-bulk-api.test.js
 */
try { require.resolve('mongodb-memory-server'); } catch {
  console.error('\n❌  חסרה חבילת הבדיקה. הרץ:\n\n   npm install --no-save mongodb-memory-server\n');
  process.exit(1);
}

const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient, ObjectId } = require('mongodb');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');

const PORT = 5429;
const B = `http://localhost:${PORT}`;
const SECRET = 'classroom-bulk-secret';
const YEAR = '2026-2027';
const LAST = '2025-2026';
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
  const uri = mongo.getUri('gan_rooms_bulk');
  const client = await MongoClient.connect(uri);
  const db = client.db('gan_rooms_bulk');

  const amutaId = new ObjectId();
  const kfarSaba = new ObjectId();
  const herzliya = new ObjectId();
  await db.collection('amutas').insertOne({ _id: amutaId, name: 'עמותת בדיקה' });
  await db.collection('branches').insertMany([
    { _id: kfarSaba, name: 'כפר סבא', amuta_id: amutaId },
    { _id: herzliya, name: 'הרצליה', amuta_id: amutaId },
  ]);
  // Last year: two good rooms in כפר סבא, plus one the old encoding bug ruined.
  await db.collection('classrooms').insertMany([
    { name: 'תינוקייה א', category: 'תינוקייה', capacity: 12, academic_year: LAST, branch_id: kfarSaba, is_active: true },
    { name: 'בוגרים א', category: 'בוגרים', capacity: 25, academic_year: LAST, branch_id: kfarSaba, is_active: true },
    { name: 'תינ��וקייה', category: null, academic_year: LAST, branch_id: kfarSaba, is_active: true },
    { name: 'בוגרים א', category: 'בוגרים', capacity: 20, academic_year: LAST, branch_id: herzliya, is_active: true },
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

  const countRooms = async (filter = {}) => {
    const c = await MongoClient.connect(uri);
    const n = await c.db('gan_rooms_bulk').collection('classrooms')
      .countDocuments({ academic_year: YEAR, ...filter });
    await c.close();
    return n;
  };

  const copyBody = { academic_year: YEAR, mode: 'copy', from_year: LAST };

  try {
    console.log('\n👀  תצוגה מקדימה לא כותבת כלום\n');
    {
      const r = await api('/api/classrooms/bulk/preview', { token: admin, method: 'POST', body: copyBody });
      eq(r.status, 200, 'התצוגה עברה');
      eq((r.json?.branches || []).length, 2, 'שני הסניפים');
      eq(await countRooms(), 0, 'ולא נוצרה אף כיתה — זו רק תצוגה');

      const ks = r.json.branches.find((b) => b.branch_name === 'כפר סבא');
      eq(ks.create.map((c) => c.name), ['בוגרים א', 'תינוקייה א'], 'שתי הכיתות התקינות מתוכננות');
      ok(ks.skipped.some((s) => /פגום/.test(s.reason)), 'והפגומה מדווחת כמדולגת');
      eq(ks.create.find((c) => c.name === 'תינוקייה א').capacity, 12, 'התקן מועתק');
    }

    console.log('\n🏗️  יצירה — כל הסניפים, לא רק הראשון\n');
    {
      const r = await api('/api/classrooms/bulk', { token: admin, method: 'POST', body: copyBody });
      eq(r.status, 200, 'היצירה עברה');
      eq(r.json?.total_created, 3, '3 כיתות סה״כ — 2 בכפר סבא, 1 בהרצליה');
      eq(await countRooms({ branch_id: kfarSaba }), 2, 'כפר סבא קיבלה שתיים');
      eq(await countRooms({ branch_id: herzliya }), 1, 'והרצליה קיבלה אחת');
      eq(await countRooms({ name: /�/ }), 0, 'והפגומה לא הועתקה');
    }

    console.log('\n🔁  הרצה שנייה לא מכפילה\n');
    {
      const r = await api('/api/classrooms/bulk', { token: admin, method: 'POST', body: copyBody });
      eq(r.json?.total_created, 0, 'לא נוצרה אף כיתה');
      eq(await countRooms(), 3, 'והמספר לא השתנה');
      const ks = r.json.branches.find((b) => b.branch_name === 'כפר סבא');
      ok(ks.skipped.every((s) => /קיימת|פגום/.test(s.reason)), 'והכל מדווח כקיים או פגום');
    }

    console.log('\n➕  יצירה מאפס משלימה את מה שחסר\n');
    {
      const r = await api('/api/classrooms/bulk', {
        token: admin, method: 'POST',
        body: {
          academic_year: YEAR, mode: 'create', branch_ids: [String(herzliya)],
          plan: [{ category: 'תינוקייה', count: 2, capacity: 12 }, { category: 'בוגרים', count: 2 }],
        },
      });
      // `count` is a target. הרצליה already has בוגרים א from the copy, so
      // asking for 2 בוגרים adds exactly one.
      eq(r.json?.total_created, 3, 'שתי תינוקיות ובוגרים ב');
      const names = r.json.branches[0].create.map((c) => c.name).sort();
      eq(names, ['בוגרים ב', 'תינוקייה א', 'תינוקייה ב'], 'והשמות ממשיכים מהקיים');
      eq(await countRooms({ branch_id: herzliya }), 4, 'הרצליה עומדת על 4');

      // The same request again must change nothing — the target is met.
      const again = await api('/api/classrooms/bulk', {
        token: admin, method: 'POST',
        body: {
          academic_year: YEAR, mode: 'create', branch_ids: [String(herzliya)],
          plan: [{ category: 'תינוקייה', count: 2, capacity: 12 }, { category: 'בוגרים', count: 2 }],
        },
      });
      eq(again.json?.total_created, 0, 'ובקשה זהה שוב לא יוצרת כלום');
      eq(await countRooms({ branch_id: herzliya }), 4, 'והמספר נשאר 4');
    }

    console.log('\n🎯  אפשר לכוון לסניף אחד בלבד\n');
    {
      const before = await countRooms({ branch_id: kfarSaba });
      const r = await api('/api/classrooms/bulk', {
        token: admin, method: 'POST',
        body: {
          academic_year: YEAR, mode: 'create', branch_ids: [String(herzliya)],
          plan: [{ category: 'צעירים', count: 1 }],
        },
      });
      eq(r.json?.total_created, 1, 'נוצרה כיתה אחת');
      eq((r.json?.branches || []).length, 1, 'ורק סניף אחד טופל');
      eq(await countRooms({ branch_id: kfarSaba }), before, 'כפר סבא לא נגעו בה');
    }
  } catch (err) {
    console.error('💥 ', err);
    failures++;
  }

  console.log(`\n${failures ? `❌  ${failures} בדיקות נכשלו\n` : '✅  הכל עבר\n'}`);
  done(failures ? 1 : 0);
})();
