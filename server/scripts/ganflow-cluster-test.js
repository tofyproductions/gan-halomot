#!/usr/bin/env node
/**
 * How many customers fit on one cluster before it stops being a good idea.
 *
 * The other wall. The scale test asks how big ONE customer can get; this asks
 * how many customers can sit together. They are different problems with
 * different answers, and the product needs both — networks of two thousand
 * branches AND a long tail of single gans.
 *
 * Each customer gets a database of its own, and each database holds 77
 * collections. Atlas is documented as degrading past roughly ten thousand
 * collections on a cluster, which puts the ceiling near 130 customers — but
 * "documented as" is somebody else's measurement of somebody else's workload.
 * `db_uri` is per-customer precisely so the 131st can go on another cluster,
 * and knowing WHERE the wall is decides whether that is a footnote or the
 * roadmap.
 *
 * WHAT THIS MEASURES AND WHAT IT DOES NOT. It provisions customers one after
 * another against a single mongod and times three things per customer: how long
 * provisioning takes, how long a cold request to a fresh customer takes, and how
 * long a request to the FIRST customer takes once everybody else exists. The
 * third is the one that matters — if customer #1 slows down as #100 arrives,
 * customers are not independent and the number of them is a shared risk.
 *
 * It runs on a laptop against a local mongod, so the absolute numbers are not
 * Atlas's. The shape is: flat means customers are independent, rising means the
 * cluster is the constraint.
 *
 *   node scripts/ganflow-cluster-test.js --count 60 --step 10
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

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const COUNT = Number(opt('count', 60));
const STEP = Number(opt('step', 10));
const PORT = Number(opt('port', 5405));
const B = `http://localhost:${PORT}`;

const waitFor = async (fn, ms = 60000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if (await fn()) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
};

const timed = async (fn) => {
  const t0 = process.hrtime.bigint();
  const out = await fn();
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, out };
};

(async () => {
  const mongo = await MongoMemoryServer.create();
  const base = mongo.getUri();
  const client = await MongoClient.connect(base);
  const plat = client.db('gf_control');

  await plat.collection('platformusers').insertOne({
    email: 'owner@example.invalid', full_name: 'בעלים', role: 'owner', is_active: true,
    password_hash: await bcrypt.hash('cluster-test-password', 12), created_at: new Date(),
  });

  const server = spawn(process.execPath, ['--max-old-space-size=2048', path.join(__dirname, '..', 'src', 'index.js')], {
    env: { ...process.env,
      MONGODB_URI: base + 'gf_unused', PLATFORM_MONGODB_URI: base + 'gf_control',
      PLATFORM_JWT_SECRET: 'cluster', JWT_SECRET: 'cluster',
      DISABLE_JOBS: '1', NODE_ENV: 'development', PORT: String(PORT) },
    stdio: 'ignore',
  });
  const stop = async () => { server.kill('SIGTERM'); await client.close().catch(() => {}); await mongo.stop().catch(() => {}); };

  try {
    if (!await waitFor(async () => (await fetch(`${B}/api/health`)).ok)) {
      console.error('\n❌  השרת לא עלה\n'); await stop(); process.exit(1);
    }

    const ctok = (await (await fetch(`${B}/api/platform/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.invalid', password: 'cluster-test-password' }),
    })).json()).token;
    if (!ctok) { console.error('\n❌  לא הצלחתי להיכנס לקונסולה\n'); await stop(); process.exit(1); }

    console.log(`\nתקרת אשכול — מקים ${COUNT} לקוחות, מודד כל ${STEP}\n`);
    console.log('לקוחות   הקמה     בקשה ללקוח חדש   בקשה ללקוח #1   אוספים');
    console.log('─'.repeat(66));

    let firstSlug = null;
    let firstToken = null;

    for (let i = 1; i <= COUNT; i++) {
      const slug = `c${String(i).padStart(3, '0')}`;
      const provision = await timed(() => fetch(`${B}/api/platform/tenants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctok}` },
        body: JSON.stringify({
          name: `לקוח ${i}`, slug, db_uri: base,
          admin_email: `${slug}@example.invalid`,
          admin_name: `מנהלת ${i}`, admin_id_number: String(500000000 + i),
        }),
      }).then((r) => r.json()).catch(() => null));

      if (!provision.out || !provision.out.tenant) {
        console.log(`  ${slug}: ההקמה נכשלה — ${JSON.stringify(provision.out).slice(0, 90)}`);
        break;
      }

      const login = async (s, i2) => (await (await fetch(`${B}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tenant': s },
        body: JSON.stringify({ full_name: `מנהלת ${i2}`, id_number: String(500000000 + i2), password: provision.out.temp_password }),
      })).json());

      if (!firstSlug) {
        firstSlug = slug;
        const step1 = await login(slug, i);
        // password_set is true now, so the first step returns needs_password.
        const withPw = await (await fetch(`${B}/api/auth/login-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-tenant': slug },
          body: JSON.stringify({ full_name: `מנהלת ${i}`, id_number: String(500000000 + i), password: provision.out.temp_password }),
        })).json();
        firstToken = withPw.token || step1.token;
      }

      if (i % STEP === 0 || i === COUNT) {
        // A customer nobody has touched — pays for opening a connection.
        const coldPw = await (await fetch(`${B}/api/auth/login-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-tenant': slug },
          body: JSON.stringify({ full_name: `מנהלת ${i}`, id_number: String(500000000 + i), password: provision.out.temp_password }),
        })).json();
        const cold = await timed(() => fetch(`${B}/api/branches`, {
          headers: { 'x-tenant': slug, Authorization: `Bearer ${coldPw.token}` },
        }).then((r) => r.status));

        // The first customer, still. This is the number that decides whether
        // customers are independent of each other or share one fate.
        const first = await timed(() => fetch(`${B}/api/branches`, {
          headers: { 'x-tenant': firstSlug, Authorization: `Bearer ${firstToken}` },
        }).then((r) => r.status));

        const cols = (await client.db().admin().listDatabases()).databases
          .filter((d) => d.name.startsWith('gf_')).length;

        console.log(
          `${String(i).padStart(6)}  ${(`${Math.round(provision.ms)}ms`).padStart(8)}  ` +
          `${(`${Math.round(cold.ms)}ms (${cold.out})`).padStart(16)}  ` +
          `${(`${Math.round(first.ms)}ms (${first.out})`).padStart(14)}  ` +
          `${String(cols * 77).padStart(7)}`,
        );
      }
    }

    console.log('─'.repeat(66));
    console.log('העמודה שקובעת היא "בקשה ללקוח #1": שטוחה = הלקוחות בלתי תלויים.');
    console.log('עולה = האשכול הוא החסם, וצריך לפזר לקוחות בין אשכולות.\n');
  } finally { await stop(); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
