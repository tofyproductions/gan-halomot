#!/usr/bin/env node
/**
 * What each person is shown, and what they are refused.
 *
 * The rollup takes the unit to summarise as a query parameter. Left alone that
 * is not a screen, it is a URL a district head edits to read the district next
 * door — the same shape as the cross-customer hole the isolation suite exists
 * for, one level down and inside a single gan network.
 *
 * So this asserts the ceiling rather than the convenience: the director sees
 * districts, a district head opening the same address sees their own branches
 * and not the network, and asking for somebody else's unit is refused rather
 * than answered with less.
 *
 *   npm install --no-save mongodb-memory-server
 *   node scripts/ganflow-orgscope.test.js
 */
try { require.resolve('mongodb-memory-server'); } catch {
  console.error('\n❌  חסרה חבילת הבדיקה. הרץ:\n\n   npm install --no-save mongodb-memory-server\n');
  process.exit(1);
}

const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient, ObjectId } = require('mongodb');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 5403;
const B = `http://localhost:${PORT}`;
const MONTH = '2026-07';
let failures = 0;

const ok = (cond, label) => { console.log(`  ${cond ? '✅' : '❌'} ${label}`); if (!cond) failures++; };

async function api(pathname, { tenant, token } = {}) {
  const headers = {};
  if (tenant) headers['x-tenant'] = tenant;
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(B + pathname, { headers });
  let json = null; try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}

const waitFor = async (fn, ms = 40000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if (await fn()) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
};

(async () => {
  const mongo = await MongoMemoryServer.create();
  const base = mongo.getUri();
  const client = await MongoClient.connect(base);
  const plat = client.db('gf_control');
  const db = client.db('gf_net');

  await plat.collection('tenants').insertOne({
    name: 'net', slug: 'net', status: 'active', db_uri: base, db_name: 'gf_net',
    pricing: {}, entitlements: {}, created_at: new Date(),
  });

  // A network, two districts, two branches each.
  const rootId = new ObjectId();
  const dA = new ObjectId(); const dB = new ObjectId();
  const branchIds = [0, 1, 2, 3].map(() => new ObjectId());
  await db.collection('branches').insertMany(branchIds.map((_id, i) => ({
    _id, name: `סניף ${i + 1}`, is_active: true, created_at: new Date(),
  })));

  const units = [
    { _id: rootId, name: 'הרשת', kind: 'network', parent_id: null, path: [], depth: 0, branch_id: null },
    { _id: dA, name: 'מחוז צפון', kind: 'district', parent_id: rootId, path: [rootId], depth: 1, branch_id: null },
    { _id: dB, name: 'מחוז דרום', kind: 'district', parent_id: rootId, path: [rootId], depth: 1, branch_id: null },
  ];
  branchIds.forEach((bid, i) => {
    const parent = i < 2 ? dA : dB;
    units.push({ _id: new ObjectId(), name: `סניף ${i + 1}`, kind: 'branch',
      parent_id: parent, path: [rootId, parent], depth: 2, branch_id: bid });
  });
  await db.collection('orgunits').insertMany(units);
  await db.collection('orgunits').createIndex({ parent_id: 1 });
  await db.collection('orgunits').createIndex({ path: 1 });

  // Rollups with numbers that make it obvious whose data came back: north's
  // branches are worth 100 each, south's 500 each.
  await db.collection('payrollrollups').insertMany(branchIds.map((bid, i) => ({
    branch_id: bid, month: MONTH, employees: 1, hours: 10,
    base: i < 2 ? 100 : 500, computed_at: new Date(),
  })));

  const people = [
    { full_name: 'מנהלת הרשת', id_number: '111111118', role: 'system_admin', org_unit_id: rootId },
    { full_name: 'מנהלת צפון', id_number: '222222226', role: 'branch_manager', org_unit_id: dA },
    { full_name: 'מנהלת דרום', id_number: '333333334', role: 'branch_manager', org_unit_id: dB },
    { full_name: 'מנהלת ללא יחידה', id_number: '444444442', role: 'branch_manager', org_unit_id: null },
  ];
  await db.collection('users').insertMany(people.map((p) => ({
    ...p, email: `${p.id_number}@example.invalid`, is_active: true, password_set: false,
    created_at: new Date(), updated_at: new Date(),
  })));

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
    env: { ...process.env,
      MONGODB_URI: base + 'gf_unused', PLATFORM_MONGODB_URI: base + 'gf_control',
      PLATFORM_JWT_SECRET: 'org', JWT_SECRET: 'org',
      DISABLE_JOBS: '1', NODE_ENV: 'development', PORT: String(PORT) },
    stdio: 'ignore',
  });
  const stop = async () => { server.kill('SIGTERM'); await client.close().catch(() => {}); await mongo.stop().catch(() => {}); };

  try {
    if (!await waitFor(async () => (await fetch(`${B}/api/health`)).ok)) {
      console.error('\n❌  השרת לא עלה\n'); await stop(); process.exit(1);
    }

    const login = async (p) => (await fetch(`${B}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tenant': 'net' },
      body: JSON.stringify({ full_name: p.full_name, id_number: p.id_number }),
    }).then((r) => r.json())).token;

    const [director, north, south, orphan] = await Promise.all(people.map(login));

    console.log('\n--- כל אחד רואה את הרמה שלו ---');
    const dirView = await api(`/api/payroll-month/rollup?month=${MONTH}`, { tenant: 'net', token: director });
    ok(dirView.status === 200 && dirView.json.rows.length === 2, `המנהלת הראשית רואה 2 מחוזות (${dirView.json?.rows?.length})`);
    ok(dirView.json?.total?.base === 1200, `וסכום הרשת שלם: ${dirView.json?.total?.base} (צפוי 1200)`);
    ok(dirView.json?.can_go_up === false, 'ואין לה לאן לעלות');

    const northView = await api(`/api/payroll-month/rollup?month=${MONTH}`, { tenant: 'net', token: north });
    ok(northView.status === 200, `מנהלת צפון מקבלת מסך (${northView.status})`);
    ok(northView.json?.node?.name === 'מחוז צפון', `והיא נוחתת על המחוז שלה: ${northView.json?.node?.name}`);
    ok(northView.json?.rows?.length === 2, `רואה את 2 הסניפים שלה (${northView.json?.rows?.length})`);
    ok(northView.json?.total?.base === 200, `ורק את הכסף שלה: ${northView.json?.total?.base} (צפוי 200)`);

    console.log('\n--- ולא את של השכנים ---');
    const cross = await api(`/api/payroll-month/rollup?month=${MONTH}&node=${dB}`, { tenant: 'net', token: north });
    ok(cross.status === 403, `צפון מבקשת את דרום — נדחית (${cross.status})`);
    ok(cross.json?.total?.base !== 500 && cross.json?.total?.base !== 1000, 'ולא קיבלה את המספרים של דרום');

    const upward = await api(`/api/payroll-month/rollup?month=${MONTH}&node=${rootId}`, { tenant: 'net', token: north });
    ok(upward.status === 403, `צפון מבקשת את הרשת כולה — נדחית (${upward.status})`);

    console.log('\n--- ירידה מותרת, עלייה לא ---');
    const ownBranch = northView.json.rows[0];
    const down = await api(`/api/payroll-month/rollup?month=${MONTH}&node=${ownBranch.id}`, { tenant: 'net', token: north });
    ok(down.status === 200, `צפון יורדת לסניף שלה (${down.status})`);
    ok(down.json?.is_leaf === true, 'ומקבלת שזה סניף — משם ממשיכים למסך המפורט');

    console.log('\n--- מי שלא שויך ---');
    const none = await api(`/api/payroll-month/rollup?month=${MONTH}`, { tenant: 'net', token: orphan });
    ok(none.status === 403, `מנהלת בלי יחידה נדחית ולא מקבלת את הרשת (${none.status})`);

    console.log('\n--- התקרה של המסך המפורט, והמחמם שמכסה עליה ---');
    // The detailed screen refusing is what stops one click freezing everybody.
    // But the summary is built from what that screen writes, so refusing alone
    // would leave a director with an honest and empty page — the warm is the
    // other half and neither is finished without the other.
    const bigBranches = [];
    for (let i = 0; i < 40; i++) bigBranches.push(new ObjectId());
    await db.collection('branches').insertMany(bigBranches.map((_id, i) => ({
      _id, name: `סניף גדול ${i}`, is_active: true, created_at: new Date(),
    })));

    const wide = await api(`/api/payroll-month?month=${MONTH}`, { tenant: 'net', token: director });
    ok(wide.status === 413, `מסך עובד-עובד מסרב מעל 25 סניפים (${wide.status})`);
    ok(Boolean(wide.json && wide.json.rollup_url), 'ומפנה לסיכום במקום להיעלם');

    const oneBranch = await api(`/api/payroll-month?month=${MONTH}&branch=${branchIds[0]}`, { tenant: 'net', token: director });
    ok(oneBranch.status === 200, `וסניף בודד ממשיך לעבוד כרגיל (${oneBranch.status})`);

    console.log(failures ? `\n❌  ${failures} בדיקות נכשלו\n` : '\n🎉 הכל עבר\n');
  } finally { await stop(); }
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
