#!/usr/bin/env node
/**
 * The two new screens, through the endpoints that feed them.
 *
 * The unit suite proves the rules. This proves the wiring, and the wiring is
 * where the interesting failures are:
 *
 *   - the roster is the whole GAN, and a child's branch is not on the child —
 *     it comes from the classroom, so this is a join that can silently return
 *     nothing
 *   - children with no classroom are COUNTED, not dropped. A roster that
 *     quietly omits people reads as complete and is not
 *   - the visibility switches persist, and the two defaults stay different
 *
 *   npm install --no-save mongodb-memory-server
 *   node scripts/supplies-api.test.js
 */
try { require.resolve('mongodb-memory-server'); } catch {
  console.error('\n❌  חסרה חבילת הבדיקה. הרץ:\n\n   npm install --no-save mongodb-memory-server\n');
  process.exit(1);
}

const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient, ObjectId } = require('mongodb');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const pv = require('../src/services/parentVisibility');

const PORT = 5427;
const B = `http://localhost:${PORT}`;
const SECRET = 'supplies-api-secret';
const YEAR = 'תשפ״ז';
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
  const uri = mongo.getUri('gan_supplies_test');
  const client = await MongoClient.connect(uri);
  const db = client.db('gan_supplies_test');

  const amutaId = new ObjectId();
  const branchId = new ObjectId();
  const otherBranch = new ObjectId();
  const roomA = new ObjectId();
  const roomB = new ObjectId();
  const roomOther = new ObjectId();
  const noaId = new ObjectId();
  const itayId = new ObjectId();

  await db.collection('amutas').insertOne({ _id: amutaId, name: 'עמותת בדיקה' });
  await db.collection('branches').insertMany([
    { _id: branchId, name: 'כפר סבא', amuta_id: amutaId },
    { _id: otherBranch, name: 'הרצליה', amuta_id: amutaId },
  ]);
  await db.collection('classrooms').insertMany([
    { _id: roomA, name: 'תינוקייה א', academic_year: YEAR, branch_id: branchId, is_active: true },
    { _id: roomB, name: 'בוגרים', academic_year: YEAR, branch_id: branchId, is_active: true },
    { _id: roomOther, name: 'בוגרים', academic_year: YEAR, branch_id: otherBranch, is_active: true },
  ]);
  await db.collection('children').insertMany([
    { _id: noaId, child_name: 'נועה כהן', classroom_id: roomA, academic_year: YEAR, is_active: true, registration_id: new ObjectId() },
    { _id: itayId, child_name: 'איתי לוי', classroom_id: roomB, academic_year: YEAR, is_active: true, registration_id: new ObjectId() },
    // Another branch — must NOT appear in this gan's roster.
    { child_name: 'ילד מהרצליה', classroom_id: roomOther, academic_year: YEAR, is_active: true, registration_id: new ObjectId() },
    // No classroom at all — counted, not listed.
    { child_name: 'ילד בלי כיתה', classroom_id: null, academic_year: YEAR, is_active: true, registration_id: new ObjectId() },
  ]);
  await client.close();

  const admin = jwt.sign({ id: String(new ObjectId()), full_name: 'רונית', role: 'system_admin' },
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

  try {
    console.log('\n🏫  הרשימה היא של הגן, לא של כיתה\n');
    {
      const r = await api(`/api/supplies?branch=${branchId}&year=${encodeURIComponent(YEAR)}`, { token: admin });
      eq(r.status, 200, 'הרשימה נטענה');
      const names = (r.json?.children || []).map((c) => c.name);
      eq(names, ['איתי לוי', 'נועה כהן'], 'שני הילדים של הגן, משתי כיתות שונות');
      ok(!names.includes('ילד מהרצליה'), 'וילד מסניף אחר לא נכנס');
      eq(r.json?.unplaced_children, 1, 'ילד בלי כיתה נספר בנפרד');
      ok((r.json?.catalogue || []).length > 10, 'ורשימת הציוד מגיעה');
    }

    console.log('\n✍️  סימון חוסרים ומה ההורה יראה\n');
    {
      const r = await api(`/api/supplies/${noaId}`, {
        token: admin, method: 'PUT',
        body: { missing: [{ key: 'wipes' }, { key: 'diapers' }] },
      });
      eq(r.status, 200, 'נשמר');
      eq((r.json?.missing || []).map((m) => m.key).sort(), ['diapers', 'wipes'], 'שני פריטים');
      eq(r.json.missing.find((m) => m.key === 'wipes').label, 'מגבונים', 'עם השם מהרשימה');
      ok(!!r.json.missing[0].emoji, 'ועם אייקון');

      const back = await api(`/api/supplies?branch=${branchId}&year=${encodeURIComponent(YEAR)}`, { token: admin });
      const noa = back.json.children.find((c) => c.name === 'נועה כהן');
      eq(noa.missing.length, 2, 'והרשימה מחזירה אותם');
      eq(noa.updated_by_name, 'רונית', 'עם מי שסימנה');
      const itay = back.json.children.find((c) => c.name === 'איתי לוי');
      eq(itay.missing.length, 0, 'לילד השני לא חסר כלום');
    }

    console.log('\n🧹  הסרה מנקה\n');
    {
      const r = await api(`/api/supplies/${noaId}`, { token: admin, method: 'PUT', body: { missing: [] } });
      eq((r.json?.missing || []).length, 0, 'הרשימה נוקתה');

      const c = await MongoClient.connect(uri);
      const row = await c.db('gan_supplies_test').collection('childsupplies').findOne({ child_id: noaId });
      await c.close();
      ok(!!row?.last_cleared_at, 'ונרשם מתי נוקתה — כדי להבדיל מ״אף אחד לא בדק״');
    }

    console.log('\n👁️  מה ההורים רואים — ברירות מחדל ושמירה\n');
    {
      const r = await api(`/api/gantt/visibility?branch=${branchId}&weeks=4`, { token: admin });
      eq(r.status, 200, 'המתגים נטענו');
      const weeks = r.json?.weeks || [];
      eq(weeks.length, 4, 'ארבעה שבועות');
      ok(weeks.every((w) => w.gantt === false), 'גאנט מוסתר בכל השבועות כברירת מחדל');
      ok(weeks.every((w) => w.menu === true), 'ותפריט מוצג בכולם');
      ok(weeks.every((w) => w.is_default), 'וכולם מסומנים כברירת מחדל');

      const target = weeks[1].week;
      const set = await api('/api/gantt/visibility', {
        token: admin, method: 'PUT',
        body: { branch_id: String(branchId), week: target, gantt: true },
      });
      eq(set.status, 200, 'פרסום שבוע נשמר');
      eq(set.json.gantt, true, 'הגאנט נפתח');
      eq(set.json.menu, true, 'והתפריט לא נגע — נשלח רק מתג אחד');
      eq(set.json.is_default, false, 'והשבוע מסומן כהחלטה');

      const after = await api(`/api/gantt/visibility?branch=${branchId}&weeks=4`, { token: admin });
      const changed = after.json.weeks.find((w) => w.week === target);
      eq(changed.gantt, true, 'ההחלטה נשמרה');
      eq(changed.set_by_name, 'רונית', 'עם מי שהחליטה');
      ok(after.json.weeks.filter((w) => w.week !== target).every((w) => w.gantt === false),
        'ושאר השבועות לא הושפעו');
    }

    console.log('\n🍽️  כיבוי התפריט נשמר בנפרד\n');
    {
      const week = pv.weekKeyOf(new Date());
      const set = await api('/api/gantt/visibility', {
        token: admin, method: 'PUT',
        body: { branch_id: String(branchId), week, menu: false },
      });
      eq(set.json.menu, false, 'התפריט הוסתר');
      eq(set.json.gantt, false, 'והגאנט נשאר כפי שהיה');
    }
  } catch (err) {
    console.error('💥 ', err);
    failures++;
  }

  console.log(`\n${failures ? `❌  ${failures} בדיקות נכשלו\n` : '✅  הכל עבר\n'}`);
  done(failures ? 1 : 0);
})();
