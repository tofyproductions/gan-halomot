#!/usr/bin/env node
/**
 * Two customers, one server, through the real HTTP stack.
 *
 * The existing platform test proves the CONNECTION layer keeps customers apart.
 * That was never the question worth asking. The question is whether the
 * application goes through that layer at all — and for a while it did not: the
 * resolver was written and never mounted, and 57 of 58 controllers read the
 * default connection no matter whose request it was.
 *
 * So this test refuses to touch any of the internals. It starts the server the
 * way Render starts it, logs in as each customer over HTTP, and asks for
 * children. What a controller does inside is not its business; what comes back
 * on the wire is.
 *
 *   npm install --no-save mongodb-memory-server
 *   node scripts/ganflow-isolation.test.js
 */
try { require.resolve('mongodb-memory-server'); } catch {
  console.error('\n❌  חסרה חבילת הבדיקה. הרץ:\n\n   npm install --no-save mongodb-memory-server\n');
  process.exit(1);
}

const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient } = require('mongodb');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
const path = require('path');

const PORT = 5399;
const B = `http://localhost:${PORT}`;
let failures = 0;

function ok(cond, label) {
  console.log(`  ${cond ? '✅' : '❌'} ${label}`);
  if (!cond) failures++;
}

async function api(pathname, { tenant, token, method = 'GET', body } = {}) {
  const headers = {};
  if (tenant) headers['x-tenant'] = tenant;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(B + pathname, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { /* empty body is fine */ }
  return { status: res.status, json };
}

const names = (r) => {
  const j = r.json;
  const arr = Array.isArray(j) ? j : (j && (j.children || j.data)) || [];
  return arr.map((x) => x.child_name).sort();
};

const waitFor = async (fn, ms = 40000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if (await fn()) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
};

(async () => {
  const mongo = await MongoMemoryServer.create();
  const base = mongo.getUri();
  const client = await MongoClient.connect(base);

  // Two customers, registered in the control plane by hand — provisioning has
  // its own test and this one must fail for isolation reasons or not at all.
  const CUSTOMERS = [
    { slug: 'alef', db: 'gf_alef', kid: 'ילד של עמותת אלף', manager: 'מנהלת אלף', id: '111111118' },
    { slug: 'bet', db: 'gf_bet', kid: 'ילד של עמותת בית', manager: 'מנהלת בית', id: '222222226' },
  ];

  const plat = client.db('gf_control');
  for (const c of CUSTOMERS) {
    await plat.collection('tenants').insertOne({
      name: c.slug, slug: c.slug, status: 'active', db_uri: base, db_name: c.db,
      pricing: {}, entitlements: {}, created_at: new Date(),
    });
    const db = client.db(c.db);
    await db.collection('children').insertOne({ child_name: c.kid, academic_year: '2026-2027', is_active: true });
    await db.collection('users').insertOne({
      full_name: c.manager, id_number: c.id, email: `${c.slug}@example.invalid`,
      role: 'system_admin', is_active: true, password_set: false,
      created_at: new Date(), updated_at: new Date(),
    });
  }

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
    env: {
      ...process.env,
      MONGODB_URI: base + 'gf_unused',
      PLATFORM_MONGODB_URI: base + 'gf_control',
      PLATFORM_JWT_SECRET: 'isolation-test',
      JWT_SECRET: 'isolation-test',
      DISABLE_JOBS: '1', NODE_ENV: 'development', PORT: String(PORT),
    },
    stdio: 'ignore',
  });

  const stop = async () => {
    server.kill('SIGTERM');
    await client.close().catch(() => {});
    await mongo.stop().catch(() => {});
  };

  try {
    const up = await waitFor(async () => (await fetch(`${B}/api/health`)).ok);
    if (!up) { console.error('\n❌  השרת לא עלה\n'); await stop(); process.exit(1); }

    console.log('\n--- בקשה בלי לקוח ---');
    const anon = await api('/api/children');
    ok(anon.status !== 200, `בקשה בלי לקוח נדחית (${anon.status})`);

    const unknown = await api('/api/children', { tenant: 'nobody' });
    ok(unknown.status === 404, `לקוח שאינו קיים מקבל 404 (${unknown.status})`);

    console.log('\n--- כל לקוח רואה את עצמו ---');
    const tokens = {};
    for (const c of CUSTOMERS) {
      const login = await api('/api/auth/login', {
        tenant: c.slug, method: 'POST', body: { full_name: c.manager, id_number: c.id },
      });
      tokens[c.slug] = login.json && login.json.token;
      ok(Boolean(tokens[c.slug]), `${c.slug}: המנהלת נכנסת`);
    }
    for (const c of CUSTOMERS) {
      const mine = await api('/api/children', { tenant: c.slug, token: tokens[c.slug] });
      ok(JSON.stringify(names(mine)) === JSON.stringify([c.kid]), `${c.slug}: רואה רק את הילד שלו`);
    }

    console.log('\n--- לקוח מנסה להגיע לשני ---');
    for (const [a, b] of [[CUSTOMERS[0], CUSTOMERS[1]], [CUSTOMERS[1], CUSTOMERS[0]]]) {
      const cross = await api('/api/children', { tenant: b.slug, token: tokens[a.slug] });
      ok(cross.status === 401, `האסימון של ${a.slug} נדחה אצל ${b.slug} (${cross.status})`);
      ok(!names(cross).includes(b.kid), `${a.slug} לא קיבל את הילד של ${b.slug}`);
    }

    console.log('\n--- לקוח מושהה ---');
    await plat.collection('tenants').updateOne({ slug: 'bet' }, { $set: { status: 'suspended' } });
    const susp = await api('/api/children', { tenant: 'bet', token: tokens.bet });
    ok(susp.status === 402, `מושהה מקבל 402 ולא נתונים (${susp.status})`);

    console.log(failures ? `\n❌  ${failures} בדיקות נכשלו\n` : '\n🎉 הכל עבר\n');
  } finally {
    await stop();
  }
  process.exit(failures ? 1 : 0);
})().catch(async (e) => { console.error(e); process.exit(1); });
