#!/usr/bin/env node
/**
 * How big can one customer get before the screens stop working.
 *
 * WHY THIS EXISTS. The application was built for a gan with four branches, and
 * it is now being sold to networks. Fifteen places in the controllers load
 * EVERY branch in one query, which is free at four and unknown at two thousand.
 * Guessing which of them matters is how a week gets spent optimising the wrong
 * one, so this measures instead: seed a customer at a given size, call the real
 * endpoints over HTTP, and record milliseconds.
 *
 * IT MEASURES A CURVE, NOT A NUMBER. Run it at several sizes and read how the
 * timings grow. Something that doubles when the data doubles is fine and can be
 * paid for; something that quadruples is a design that has to change, and no
 * amount of hardware buys its way out. One measurement at one size cannot tell
 * those apart, which is the whole reason the sizes are a list.
 *
 *   node scripts/ganflow-scale-test.js --sizes 10,100,500
 *   node scripts/ganflow-scale-test.js --sizes 2000 --keep    # leave the data
 *
 * Per branch it seeds the ratios measured in production on 20.08.2026:
 * 42 employees and 12,647 punches. Children are seeded at 40 rather than the
 * 18 production currently holds — that number is low because the year's intake
 * has not been entered yet, and sizing a network on it would be sizing on a
 * gap in the data rather than on a gan.
 *
 * Punches are the expensive part to generate, so --punch-share writes a
 * fraction of them and the report says plainly that it did. A screen that is
 * slow with a tenth of the punches is not going to be fast with all of them.
 */
try { require.resolve('mongodb-memory-server'); } catch {
  console.error('\n❌  חסרה חבילת הבדיקה. הרץ:\n\n   npm install --no-save mongodb-memory-server\n');
  process.exit(1);
}

const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient, ObjectId } = require('mongodb');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
const path = require('path');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const SIZES = String(opt('sizes', '10,100,500')).split(',').map(Number).filter(Boolean);
const PUNCH_SHARE = Number(opt('punch-share', 0.1));
const PORT = Number(opt('port', 5401));
const B = `http://localhost:${PORT}`;

const PER_BRANCH = { employees: 42, children: 40, punches: 12647 };
const SLOW_MS = 1000;   // a screen a manager waits on
const BAD_MS = 3000;    // a screen a manager gives up on

const api = async (pathname, { tenant, token } = {}) => {
  const headers = {};
  if (tenant) headers['x-tenant'] = tenant;
  if (token) headers.Authorization = `Bearer ${token}`;
  const t0 = process.hrtime.bigint();
  let status = 0; let bytes = 0;
  try {
    const res = await fetch(B + pathname, { headers });
    status = res.status;
    bytes = (await res.text()).length;
  } catch (e) { status = -1; }
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, status, bytes };
};

const waitFor = async (fn, ms = 60000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if (await fn()) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
};

const YEAR = '2026-2027';
const MONTH = '2026-07';

async function seed(client, dbName, branches) {
  const db = client.db(dbName);
  const bulkOpts = { ordered: false };

  const branchIds = [];
  const branchDocs = [];
  for (let i = 0; i < branches; i++) {
    const _id = new ObjectId();
    branchIds.push(_id);
    branchDocs.push({ _id, name: `סניף ${i + 1}`, is_active: true, created_at: new Date() });
  }
  await db.collection('branches').insertMany(branchDocs, bulkOpts);

  // The administrator this test logs in as.
  await db.collection('users').insertOne({
    full_name: 'מנהלת עומס', id_number: '900000009', email: 'scale@example.invalid',
    role: 'system_admin', is_active: true, password_set: false,
    branch_id: branchIds[0], created_at: new Date(),
  });

  const CHUNK = 5000;
  const flush = async (col, rows) => { if (rows.length) await db.collection(col).insertMany(rows, bulkOpts); };

  let employees = [], children = [], classrooms = [], punches = [];
  const employeeIds = [];
  const punchesPerEmployee = Math.max(1, Math.round((PER_BRANCH.punches * PUNCH_SHARE) / PER_BRANCH.employees));

  for (let b = 0; b < branches; b++) {
    const branch_id = branchIds[b];

    const roomId = new ObjectId();
    classrooms.push({ _id: roomId, name: 'בוגרים', category: 'בוגרים', academic_year: YEAR,
      capacity: 35, is_active: true, branch_id, created_at: new Date() });

    for (let e = 0; e < PER_BRANCH.employees; e++) {
      const _id = new ObjectId();
      employeeIds.push(_id);
      employees.push({ _id, full_name: `עובדת ${b}-${e}`, id_number: String(200000000 + b * 100 + e),
        branch_id, is_active: true, role_type: 'general', hourly_rate: 45, created_at: new Date() });

      for (let p = 0; p < punchesPerEmployee; p++) {
        punches.push({
          employee_id: _id, branch_id, israeli_id: String(200000000 + b * 100 + e),
          timestamp: new Date(2026, 6, 1 + (p % 28), 7 + (p % 10), 0, 0),
          year_month: MONTH, approval_status: 'approved', created_at: new Date(),
        });
      }
      if (punches.length >= CHUNK) { await flush('punches', punches); punches = []; }
    }

    for (let c = 0; c < PER_BRANCH.children; c++) {
      children.push({ child_name: `ילד ${b}-${c}`, academic_year: YEAR, is_active: true,
        branch_id, classroom_id: roomId, birth_date: new Date(2023, c % 12, 1), created_at: new Date() });
    }

    if (employees.length >= CHUNK) { await flush('employees', employees); employees = []; }
    if (children.length >= CHUNK) { await flush('children', children); children = []; }
    if (classrooms.length >= CHUNK) { await flush('classrooms', classrooms); classrooms = []; }
  }
  await flush('employees', employees);
  await flush('children', children);
  await flush('classrooms', classrooms);
  await flush('punches', punches);

  // The indexes production has. Without them this measures a missing index
  // rather than the shape of the code, which is a different and less useful
  // finding — production already has these.
  await db.collection('punches').createIndexes([
    { key: { branch_id: 1 } }, { key: { employee_id: 1 } },
    { key: { employee_id: 1, timestamp: -1 } }, { key: { timestamp: 1 } },
  ]);
  await db.collection('employees').createIndex({ branch_id: 1 });
  await db.collection('children').createIndex({ branch_id: 1 });
  await db.collection('children').createIndex({ academic_year: 1 });

  const counts = {};
  for (const c of ['branches', 'employees', 'children', 'punches']) {
    counts[c] = await db.collection(c).countDocuments();
  }
  return counts;
}

const SCREENS = [
  ['סניפים', '/api/branches'],
  ['ילדים', `/api/children?academic_year=${YEAR}`],
  ['עובדים', '/api/payroll/employees'],
  ['לוח בקרה', `/api/dashboard/stats?academic_year=${YEAR}`],
  ['גבייה', `/api/collections?academic_year=${YEAR}`],
  // The two that matter most, and the reason this file exists: both load every
  // branch in the customer before they do anything else.
  ['שכר — כל הסניפים', `/api/payroll-month?month=${MONTH}`],
  ['נוכחות — סניף אחד', `/api/payroll/attendance?month=${MONTH}&branch=__BRANCH__`],
];

(async () => {
  const mongo = await MongoMemoryServer.create();
  const base = mongo.getUri();
  const client = await MongoClient.connect(base);
  const plat = client.db('gf_control');

  await plat.collection('platformusers').insertOne({
    email: 'scale@example.invalid', full_name: 'עומס', role: 'owner', is_active: true,
    password_hash: await bcrypt.hash('scale-test-password', 12), created_at: new Date(),
  });

  const server = spawn(process.execPath, ['--max-old-space-size=1024', path.join(__dirname, '..', 'src', 'index.js')], {
    env: { ...process.env,
      MONGODB_URI: base + 'gf_unused', PLATFORM_MONGODB_URI: base + 'gf_control',
      PLATFORM_JWT_SECRET: 'scale', JWT_SECRET: 'scale',
      DISABLE_JOBS: '1', NODE_ENV: 'development', PORT: String(PORT) },
    stdio: 'ignore',
  });
  const stop = async () => { server.kill('SIGTERM'); await client.close().catch(() => {}); await mongo.stop().catch(() => {}); };

  try {
    if (!await waitFor(async () => (await fetch(`${B}/api/health`)).ok)) {
      console.error('\n❌  השרת לא עלה\n'); await stop(); process.exit(1);
    }

    console.log(`\nמדידת עומס — ${PUNCH_SHARE * 100}% מההחתמות האמיתיות לכל עובד\n`);
    const table = {};

    for (const size of SIZES) {
      const slug = `scale${size}`;
      const dbName = `gf_${slug}`;
      await plat.collection('tenants').insertOne({
        name: slug, slug, status: 'active', db_uri: base, db_name: dbName,
        pricing: {}, entitlements: {}, created_at: new Date(),
      });

      process.stdout.write(`  זורע ${size} סניפים… `);
      const t0 = Date.now();
      const counts = await seed(client, dbName, size);
      console.log(`${((Date.now() - t0) / 1000).toFixed(0)}ש  ` +
        `(${counts.employees} עובדים, ${counts.children} ילדים, ${counts.punches} החתמות)`);

      const login = await fetch(`${B}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tenant': slug },
        body: JSON.stringify({ full_name: 'מנהלת עומס', id_number: '900000009' }),
      }).then((r) => r.json()).catch(() => ({}));

      if (!login.token) { console.log(`  ⚠️  לא הצלחתי להיכנס ל-${slug} — מדלג\n`); continue; }

      // One real branch id, for the screens a manager opens on their own branch
      // rather than on the whole network.
      const oneBranch = await client.db(dbName).collection('branches').findOne({});

      for (const [label, rawUrl] of SCREENS) {
        const url = rawUrl.replace('__BRANCH__', String(oneBranch && oneBranch._id));
        await api(url, { tenant: slug, token: login.token });          // warm
        const runs = [];
        for (let i = 0; i < 3; i++) runs.push(await api(url, { tenant: slug, token: login.token }));
        const best = runs.reduce((a, b) => (a.ms < b.ms ? a : b));
        (table[label] ||= {})[size] = best;
      }
      console.log('');
    }

    const head = SIZES.map((s) => String(s).padStart(11)).join('');
    console.log('─'.repeat(22 + head.length));
    console.log('מסך'.padEnd(22) + head);
    console.log('─'.repeat(22 + head.length));
    for (const [label, bySize] of Object.entries(table)) {
      const cells = SIZES.map((s) => {
        const r = bySize[s];
        if (!r) return '—'.padStart(11);
        if (r.status !== 200) return `${r.status}`.padStart(11);
        const mark = r.ms > BAD_MS ? '!!' : r.ms > SLOW_MS ? '!' : '';
        return `${Math.round(r.ms)}ms${mark}`.padStart(11);
      }).join('');
      console.log(label.padEnd(22) + cells);
    }
    console.log('─'.repeat(22 + head.length));
    console.log(`!  מעל ${SLOW_MS}ms      !!  מעל ${BAD_MS}ms      מספר = קוד שגיאה\n`);

    // The growth rate is the finding. Timings that rise faster than the data
    // are the screens that no bigger server will save.
    if (SIZES.length >= 2) {
      const [small, big] = [SIZES[0], SIZES[SIZES.length - 1]];
      const dataGrowth = big / small;
      console.log(`מ-${small} ל-${big} סניפים הנתונים גדלו פי ${dataGrowth.toFixed(0)}:\n`);
      for (const [label, bySize] of Object.entries(table)) {
        const a = bySize[small]; const b = bySize[big];
        if (!a || !b || a.status !== 200 || b.status !== 200) continue;
        const grew = b.ms / Math.max(a.ms, 1);
        const verdict = grew > dataGrowth * 1.5 ? '⚠️  גרוע מליניארי — שינוי מבנה'
          : grew > dataGrowth * 0.5 ? 'ליניארי — חומרה תעזור'
          : 'קבוע — בסדר';
        console.log(`  ${label.padEnd(20)} פי ${grew.toFixed(1)}   ${verdict}`);
      }
      console.log('');
    }
  } finally {
    if (!argv.includes('--keep')) await stop();
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
