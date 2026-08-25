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

    console.log('\n--- לקוח שהוקם דרך הקונסולה יכול להיכנס ---');
    // The one that mattered: provisioning built a customer a database, an
    // administrator and a temporary password, and the administrator had no id
    // number — which is half of what login matches on. A customer was being
    // handed a system nobody could open, and nothing failed while it happened.
    const owner = await plat.collection('platformusers').insertOne({
      email: 'owner@example.invalid', full_name: 'בעלים', role: 'owner',
      // is_active is a schema default, and a raw insert does not get defaults —
      // the console login filters on it, so without this the owner cannot log in.
      is_active: true,
      password_hash: await bcrypt.hash('console-password-long', 12), created_at: new Date(),
    });
    ok(Boolean(owner.insertedId), 'נוצר משתמש קונסולה');

    const consoleLogin = await api('/api/platform/login', {
      method: 'POST', body: { email: 'owner@example.invalid', password: 'console-password-long' },
    });
    const ctok = consoleLogin.json && consoleLogin.json.token;
    ok(Boolean(ctok), 'הבעלים נכנס לקונסולה');

    const noId = await api('/api/platform/tenants', {
      method: 'POST', token: ctok,
      body: { name: 'ללא תז', slug: 'noid', admin_email: 'x@example.invalid', admin_name: 'מנהלת' },
    });
    ok(noId.status === 400, `הקמה בלי תעודת זהות נדחית (${noId.status})`);

    const short = await api('/api/platform/tenants', {
      method: 'POST', token: ctok,
      body: { name: 'תז קצרה', slug: 'shortid', admin_email: 'x@example.invalid', admin_name: 'מנהלת', admin_id_number: '12' },
    });
    ok(short.status === 400, `תעודת זהות קצרה נדחית (${short.status})`);
    const afterBad = await plat.collection('tenants').countDocuments({ slug: { $in: ['noid', 'shortid'] } });
    ok(afterBad === 0, 'הקמה שנדחתה לא משאירה לקוח חצי');

    const made = await api('/api/platform/tenants', {
      method: 'POST', token: ctok,
      body: {
        name: 'גני חדש', slug: 'chadash', db_uri: base,
        admin_email: 'new@example.invalid', admin_name: 'מנהלת חדשה', admin_id_number: '333333334',
      },
    });
    ok(made.status === 201, `הלקוח הוקם (${made.status})`);
    const madeId = made.json && made.json.tenant && made.json.tenant._id;
    const temp = made.json && made.json.temp_password;
    ok(Boolean(temp), 'הוחזרה סיסמה זמנית');

    const step1 = await api('/api/auth/login', {
      tenant: 'chadash', method: 'POST', body: { full_name: 'מנהלת חדשה', id_number: '333333334' },
    });
    ok(step1.json && step1.json.needs_password === true, 'הכניסה דורשת סיסמה ולא מנפיקה אסימון');
    ok(!(step1.json && step1.json.token), 'לא הונפק אסימון בלי סיסמה');

    const wrong = await api('/api/auth/login-password', {
      tenant: 'chadash', method: 'POST',
      body: { full_name: 'מנהלת חדשה', id_number: '333333334', password: 'not-it' },
    });
    ok(wrong.status === 401, `סיסמה שגויה נדחית (${wrong.status})`);

    const right = await api('/api/auth/login-password', {
      tenant: 'chadash', method: 'POST',
      body: { full_name: 'מנהלת חדשה', id_number: '333333334', password: temp },
    });
    ok(Boolean(right.json && right.json.token), 'המנהלת נכנסת עם הסיסמה הזמנית');

    const tempToken = right.json && right.json.token;
    ok(right.json && right.json.user && right.json.user.must_change_password === true,
      'האסימון אומר שהסיסמה זמנית');

    // The whole point: a password somebody else chose buys ONE thing.
    const blocked = await api('/api/branches', { tenant: 'chadash', token: tempToken });
    ok(blocked.status === 403, `⚠️  עם סיסמה זמנית אי אפשר לעשות דבר (${blocked.status})`);

    const chose = await api('/api/auth/set-password', {
      tenant: 'chadash', method: 'POST', token: tempToken, body: { password: 'shelah-1234' },
    });
    ok(chose.status === 200 && Boolean(chose.json.token), 'אבל אפשר לבחור סיסמה');

    // The new token is what lifts it. Without one she would choose a password
    // and be locked out by the choice.
    const hers = await api('/api/branches', { tenant: 'chadash', token: chose.json && chose.json.token });
    ok(hers.status === 200, `ואז המערכת עונה לה (${hers.status})`);

    const again = await api('/api/auth/login-password', {
      tenant: 'chadash', method: 'POST',
      body: { full_name: 'מנהלת חדשה', id_number: '333333334', password: temp },
    });
    ok(again.status === 401, `הסיסמה הזמנית כבר לא עובדת (${again.status})`);

    console.log('\n--- כניסת תמיכה ---');
    // The feature that sells and the one a security review asks about first:
    // our staff inside a customer's records. It is only defensible if it can
    // look and cannot touch, so that is what is asserted — not that it works.
    const noReason = await api(`/api/platform/tenants/${madeId}/impersonate`, {
      method: 'POST', token: ctok, body: {},
    });
    ok(noReason.status === 400, `כניסה בלי סיבה נדחית (${noReason.status})`);

    const imp = await api(`/api/platform/tenants/${madeId}/impersonate`, {
      method: 'POST', token: ctok, body: { reason: 'בדיקה אוטומטית' },
    });
    ok(imp.status === 200 && Boolean(imp.json.token), `נוצרה כניסת תמיכה (${imp.status})`);
    ok(imp.json?.read_only === true, 'ומסומנת כצפייה בלבד');

    const stok = imp.json && imp.json.token;
    const canRead = await api('/api/branches', { tenant: 'chadash', token: stok });
    ok(canRead.status === 200, `התמיכה רואה את המסכים (${canRead.status})`);

    const cannotWrite = await api('/api/branches', {
      tenant: 'chadash', token: stok, method: 'POST', body: { name: 'סניף שהתמיכה ניסתה ליצור' },
    });
    ok(cannotWrite.status === 403, `אבל לא יכולה לכתוב (${cannotWrite.status})`);

    const branchesAfter = await client.db('gf_chadash').collection('branches')
      .countDocuments({ name: 'סניף שהתמיכה ניסתה ליצור' });
    ok(branchesAfter === 0, 'ושום דבר לא נוצר במסד של הלקוח');

    const elsewhere = await api('/api/branches', { tenant: 'alef', token: stok });
    ok(elsewhere.status === 401, `ואסימון התמיכה לא עובד אצל לקוח אחר (${elsewhere.status})`);

    const logged = await plat.collection('auditlogs')
      .countDocuments({ action: 'tenant.impersonate', tenant_slug: 'chadash' });
    ok(logged >= 1, `הכניסה נרשמה ביומן (${logged})`);

    console.log('\n--- העברת לקוח למסד אחר ---');
    // A customer created against the wrong database is not a hypothetical —
    // it is how this was found. What matters is that looking is separate from
    // moving, and that the old database is left exactly as it was.
    await client.db('gf_chadash').collection('children').insertOne({
      child_name: 'ילדה במסד הישן', academic_year: 'תשפ"ו', is_active: true });
    await client.db('donor_db').collection('children').insertMany([
      { child_name: 'ילדה במסד החדש', academic_year: 'תשפ"ו', is_active: true },
      { child_name: 'ילד במסד החדש', academic_year: 'תשפ"ו', is_active: true },
    ]);

    const peek = await api(`/api/platform/tenants/${madeId}/database`, {
      method: 'PATCH', token: ctok, body: { db_name: 'donor_db', check: true },
    });
    ok(peek.status === 200 && peek.json.found.children === 2,
      `בדיקה מראה מה יש במסד היעד (${peek.json && peek.json.found && peek.json.found.children})`);

    // Read through the customer's own connection, which is what a move has to
    // change — /api/children is scoped to the caller's branches and would say
    // nothing about which database answered.
    const usage = async () => {
      const r = await api(`/api/platform/tenants/${madeId}`, { token: ctok });
      return r.json && r.json.usage ? r.json.usage.children : -1;
    };
    ok(await usage() === 1, 'בדיקה בלבד לא מזיזה את הלקוח');

    const bad = await api(`/api/platform/tenants/${madeId}/database`, {
      method: 'PATCH', token: ctok, body: { db_name: 'has.a.dot' },
    });
    ok(bad.status === 400, `שם מסד לא תקין נדחה (${bad.status})`);

    const moved = await api(`/api/platform/tenants/${madeId}/database`, {
      method: 'PATCH', token: ctok, body: { db_name: 'donor_db' },
    });
    ok(moved.status === 200, `הלקוח הועבר (${moved.status})`);

    // The cache is keyed on slug, so without eviction the customer would keep
    // answering from the old database and the move would look like a no-op.
    const nowCount = await usage();
    ok(nowCount === 2, `⚠️  הלקוח רואה מיד את המסד החדש (${nowCount})`);

    const oldIntact = await client.db('gf_chadash').collection('children').countDocuments();
    ok(oldIntact === 1, 'המסד הישן נשאר כפי שהיה');

    // A database that was born elsewhere has no org root, and the screens that
    // stand on it then answer "no org chart" — which reads as a bug. Found on
    // the demo right after moving it.
    const rootAfter = await client.db('donor_db').collection('orgunits')
      .countDocuments({ parent_id: null });
    ok(rootAfter === 1, `⚠️  מסד שהועבר מקבל שורש לעץ הארגוני (${rootAfter})`);

    const dbLogged = await plat.collection('auditlogs')
      .countDocuments({ action: 'tenant.database', tenant_slug: 'chadash' });
    ok(dbLogged === 1, `ההעברה נרשמה ביומן (${dbLogged})`);

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
