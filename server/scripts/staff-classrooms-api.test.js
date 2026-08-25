#!/usr/bin/env node
/**
 * Room assignment, through the endpoints that actually carry it.
 *
 * The unit suite proves the rule. This proves the rule is WIRED — which is a
 * different claim, and the one that fails silently:
 *
 *   - the employee card stores and returns the rooms
 *   - a גננת cannot be created or left without one
 *   - a branch manager's room change applies NOW rather than queueing behind
 *     the accountant, because moving a סייעת between rooms on a Sunday
 *     morning is her job and cannot wait for bookkeeping
 *   - the contact sheet names the staff per room, primary first
 *
 * The last one is the point of the feature: a page at the door that says who
 * is responsible for these children.
 *
 *   npm install --no-save mongodb-memory-server
 *   node scripts/staff-classrooms-api.test.js
 */
try { require.resolve('mongodb-memory-server'); } catch {
  console.error('\n❌  חסרה חבילת הבדיקה. הרץ:\n\n   npm install --no-save mongodb-memory-server\n');
  process.exit(1);
}

const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient, ObjectId } = require('mongodb');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');

const PORT = 5423;
const B = `http://localhost:${PORT}`;
const SECRET = 'staff-rooms-secret';
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
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json, text };
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
  const uri = mongo.getUri('gan_rooms_test');
  const client = await MongoClient.connect(uri);
  const db = client.db('gan_rooms_test');

  const branchId = new ObjectId();
  const amutaId = new ObjectId();
  const roomA = new ObjectId();   // בוגרים
  const roomB = new ObjectId();   // תינוקייה
  const YEAR = 'תשפ״ז';

  await db.collection('amutas').insertOne({ _id: amutaId, name: 'עמותת בדיקה' });
  await db.collection('branches').insertOne({ _id: branchId, name: 'כפר סבא', amuta_id: amutaId });
  await db.collection('classrooms').insertMany([
    { _id: roomA, name: 'בוגרים', academic_year: YEAR, branch_id: branchId, is_active: true },
    { _id: roomB, name: 'תינוקייה', academic_year: YEAR, branch_id: branchId, is_active: true },
  ]);
  await db.collection('children').insertMany([
    { child_name: 'נועה כהן', parent_name: 'רות כהן', phone: '0501111111', classroom_id: roomA, is_active: true, academic_year: YEAR },
    { child_name: 'איתי לוי', parent_name: 'דנה לוי', phone: '0502222222', classroom_id: roomB, is_active: true, academic_year: YEAR },
  ]);
  await client.close();

  const token = (role, extra = {}) => jwt.sign({
    id: String(new ObjectId()), full_name: role === 'accountant' ? 'הנהלת חשבונות' : 'מנהלת סניף',
    role, ...extra,
  }, SECRET, { expiresIn: '1h' });
  const admin = token('system_admin');
  const manager = token('branch_manager', { managed_branch_ids: [String(branchId)], branch_id: String(branchId) });

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

  let teacherId = null;
  try {
    console.log('\n🚫  גננת בלי כיתה לא נוצרת\n');
    {
      const r = await api('/api/payroll/employees', {
        token: admin, method: 'POST',
        body: { full_name: 'שירה גננת', branch_id: String(branchId), position: 'גננת', primary_classroom_id: null },
      });
      eq(r.status, 400, 'היצירה נדחית');
      ok(/חובה/.test(r.json?.error || ''), 'וההסבר אומר שהתפקיד מחייב כיתה');
    }

    console.log('\n✅  עם כיתה — נוצרת ונשמרת\n');
    {
      const r = await api('/api/payroll/employees', {
        token: admin, method: 'POST',
        body: {
          full_name: 'שירה גננת', branch_id: String(branchId), position: 'גננת', phone: '0503333333',
          primary_classroom_id: String(roomA), extra_classroom_ids: [String(roomB), String(roomA)],
        },
      });
      eq(r.status, 201, 'נוצרה');
      teacherId = r.json?.employee?.id || r.json?.employee?._id;

      const back = await api(`/api/payroll/employees?branch=${branchId}`, { token: admin });
      const her = (back.json?.employees || []).find((e) => e.full_name === 'שירה גננת');
      eq(String(her?.primary_classroom_id), String(roomA), 'הכיתה הראשית חזרה נכון');
      eq((her?.extra_classroom_ids || []).map(String), [String(roomB)],
        'והכיתה שהופיעה גם כראשית וגם כנוספת לא נכפלה');
    }

    console.log('\n🍳  טבחית בלי כיתה — מותר\n');
    {
      const r = await api('/api/payroll/employees', {
        token: admin, method: 'POST',
        body: { full_name: 'מרים טבחית', branch_id: String(branchId), position: 'טבחית' },
      });
      eq(r.status, 201, 'נוצרה בלי כיתה');
    }

    console.log('\n⏱️  מנהלת סניף מזיזה כיתה — מיד, לא דרך אישור\n');
    {
      const r = await api(`/api/payroll/employees/${teacherId}`, {
        token: manager, method: 'PUT', body: { primary_classroom_id: String(roomB) },
      });
      ok(r.status === 200, 'הבקשה עברה');
      ok(!r.json?.pending_approval, 'ולא נפתחה בקשת אישור להנהלת חשבונות');

      const back = await api(`/api/payroll/employees?branch=${branchId}`, { token: admin });
      const her = (back.json?.employees || []).find((e) => e.full_name === 'שירה גננת');
      eq(String(her?.primary_classroom_id), String(roomB), 'והשינוי כבר בכרטיס');
    }

    console.log('\n📄  דף הקשר אומר מי אחראית\n');
    {
      // Put her back in בוגרים as primary, still helping in תינוקייה.
      await api(`/api/payroll/employees/${teacherId}`, {
        token: admin, method: 'PUT',
        body: { primary_classroom_id: String(roomA), extra_classroom_ids: [String(roomB)] },
      });

      const r = await api('/api/contacts/pdf', { token: admin });
      eq(r.status, 200, 'הדף נוצר');
      const html = r.text || '';
      ok(html.includes('שירה גננת'), 'שם הגננת מופיע');
      ok(html.includes('(גננת)'), 'עם התפקיד');
      ok(html.includes('0503333333'), 'ועם הטלפון');
      ok(html.includes('נוספת'), 'והכיתה שהיא רק עוזרת בה מסומנת ככזו');
      ok(!html.includes('מרים טבחית'), 'הטבחית לא מופיעה — היא לא משויכת לכיתה');

      // The section she is only additional in must say so; the one she leads
      // must not. Checking the order inside the תינוקייה block.
      const infantBlock = html.slice(html.indexOf('תינוקייה'));
      ok(/שירה גננת[^|<]*נוספת/.test(infantBlock), 'בתינוקייה היא מסומנת נוספת');
      const olderBlock = html.slice(html.indexOf('בוגרים'), html.indexOf('תינוקייה') > html.indexOf('בוגרים') ? html.indexOf('תינוקייה') : undefined);
      ok(!/שירה גננת[^|<]*נוספת/.test(olderBlock), 'ובבוגרים היא לא');
    }

    console.log('\n🛡️  שם עם תו HTML לא שובר את הדף\n');
    {
      const c2 = await MongoClient.connect(uri);
      await c2.db('gan_rooms_test').collection('children').insertOne({
        child_name: 'יעל <3 כהן', parent_name: 'אמא', phone: '0504444444',
        classroom_id: roomA, is_active: true, academic_year: YEAR,
      });
      await c2.close();
      const r = await api('/api/contacts/pdf', { token: admin });
      ok((r.text || '').includes('יעל &lt;3 כהן'), 'התו מומר ולא נבלע');
    }
  } catch (err) {
    console.error('💥 ', err);
    failures++;
  }

  console.log(`\n${failures ? `❌  ${failures} בדיקות נכשלו\n` : '✅  הכל עבר\n'}`);
  done(failures ? 1 : 0);
})();
