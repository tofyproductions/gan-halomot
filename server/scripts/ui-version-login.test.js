#!/usr/bin/env node
/**
 * The interface a person chose is the one she gets on the FIRST frame.
 *
 * WHAT WENT WRONG. `applyAuth` in useAuth.jsx sets the client's `user` to the
 * body of the login response, and that body is the JWT payload built by
 * makeToken — not a read of the record. Anything missing from the payload is
 * therefore missing from the client until /auth/me runs, which is on window
 * focus or the 60-second refresh, whichever comes first.
 *
 * For a permission that is harmless: the gates are the token's job and every
 * claim they read is already in there. For `ui_version` it is the whole
 * screen. useUiVersion resolves `pending || serverValue || cache || 'classic'`
 * and shows the switch offer when `ui_version_asked` is falsy — so with both
 * fields absent, somebody who chose the redesign on her phone logged in at the
 * office, got the classic shell AND the offer a second time, and then watched
 * the interface change under her a minute later when /me finally answered.
 *
 * It was found on the demo, where it is worse than an annoyance: all 102
 * accounts are set to the redesign precisely so a prospect never sees the
 * interface we are replacing, and every one of them opened on it anyway, under
 * a dialog asking the prospect to choose between two designs.
 *
 * WHY IT RUNS A SERVER. The bug is not visible in the source — makeToken's
 * payload looked complete, and it is complete for everything the middleware
 * reads. It is only visible on the wire, which is why this logs in over HTTP
 * and reads the response body rather than asserting on the file.
 *
 *   npm install --no-save mongodb-memory-server
 *   node scripts/ui-version-login.test.js
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

const PORT = 5423;
const B = `http://localhost:${PORT}`;
let failures = 0;

function ok(cond, label, detail = '') {
  console.log(`  ${cond ? '✅' : '❌'} ${label}${!cond && detail ? `\n     ${detail}` : ''}`);
  if (!cond) failures++;
}

async function post(pathname, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(B + pathname, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function get(pathname, token) {
  const res = await fetch(B + pathname, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const waitFor = async (fn, ms = 40000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if (await fn()) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
};

/**
 * Three accounts, one per state the field can be in. The third is the one that
 * must NOT change: "never asked" is every account in the four gans running on
 * the classic shell today, and carrying the field must leave them exactly where
 * they were — classic, and offered the switch once.
 */
const PEOPLE = [
  {
    label: 'בחרה בחדש',
    full_name: 'מנהלת חדשה', id_number: '111111118',
    set: { ui_version: 'new', ui_version_asked: true },
    expect: { ui_version: 'new', ui_version_asked: true },
  },
  {
    label: 'בחרה להישאר בקלאסי',
    full_name: 'מנהלת קלאסית', id_number: '222222226',
    set: { ui_version: 'classic', ui_version_asked: true },
    expect: { ui_version: 'classic', ui_version_asked: true },
  },
  {
    label: 'לא נשאלה מעולם',
    full_name: 'מנהלת חדשה לגמרי', id_number: '333333334',
    set: {},
    expect: { ui_version: null, ui_version_asked: false },
  },
];

(async () => {
  const mongo = await MongoMemoryServer.create();
  const base = mongo.getUri();
  const client = await MongoClient.connect(base);
  const db = client.db('gf_ui');

  const hash = await bcrypt.hash('Secret2026!', 10);
  const branch = await db.collection('branches').insertOne({ name: 'סניף בדיקה' });
  for (const p of PEOPLE) {
    await db.collection('users').insertOne({
      full_name: p.full_name, id_number: p.id_number,
      email: `${p.id_number}@example.invalid`,
      role: 'system_admin', is_active: true,
      password_set: true, password_hash: hash,
      branch_id: branch.insertedId,
      ...p.set,
      created_at: new Date(), updated_at: new Date(),
    });
  }

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
    env: {
      ...process.env,
      MONGODB_URI: base + 'gf_ui',
      JWT_SECRET: 'ui-version-test',
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

    const norm = (v) => (v === undefined ? null : v);

    for (const p of PEOPLE) {
      console.log(`\n--- ${p.label} ---`);

      const login = await post('/api/auth/login-password', {
        full_name: p.full_name, id_number: p.id_number, password: 'Secret2026!',
      });
      ok(login.status === 200, `נכנסת (${login.status})`);

      const u = (login.json && login.json.user) || {};

      /**
       * The assertion the bug was hiding behind. Before this fix the login body
       * carried neither field, so both read `undefined` here — which is the
       * same thing the client saw, and the reason it fell back to 'classic'
       * with the offer on top.
       */
      ok(
        norm(u.ui_version) === p.expect.ui_version,
        `תגובת ההתחברות נושאת את העיצוב (${JSON.stringify(norm(u.ui_version))})`,
        `ציפיתי ל-${JSON.stringify(p.expect.ui_version)}`,
      );
      ok(
        !!u.ui_version_asked === p.expect.ui_version_asked,
        `ותגובת ההתחברות יודעת אם נשאלה (${!!u.ui_version_asked})`,
        `ציפיתי ל-${p.expect.ui_version_asked}`,
      );

      // /auth/me was always right. It is asserted anyway, because the value of
      // the fix is that the two AGREE — a login that disagreed with the profile
      // is exactly what made the interface change a minute after it rendered.
      const me = await get('/api/auth/me', login.json.token);
      ok(me.status === 200, `הפרופיל נקרא (${me.status})`);
      const m = (me.json && me.json.user) || {};
      ok(
        norm(m.ui_version) === norm(u.ui_version),
        'ההתחברות והפרופיל מסכימים על העיצוב',
        `התחברות ${JSON.stringify(norm(u.ui_version))} מול פרופיל ${JSON.stringify(norm(m.ui_version))}`,
      );
      ok(
        !!m.ui_version_asked === !!u.ui_version_asked,
        'ומסכימים אם נשאלה',
      );
    }

    /**
     * A preference is not a gate, and /me must not mint a fresh token over it.
     * tokenClaimsDiffer compares a fixed list of claims; if ui_version ever
     * joined it, the first /me after a deploy would mint a token for every
     * account on the system to no effect — and every 60-second refresh after a
     * switch would mint another.
     */
    console.log('\n--- העדפה אינה שער ---');
    const p = PEOPLE[0];
    const login = await post('/api/auth/login-password', {
      full_name: p.full_name, id_number: p.id_number, password: 'Secret2026!',
    });
    const me = await get('/api/auth/me', login.json.token);
    ok(!me.json.token, 'הפרופיל לא מנפיק אסימון חדש בגלל העדפת עיצוב');
  } finally {
    await stop();
  }

  console.log(failures ? `\n❌  ${failures} כשלונות\n` : '\n🎉 הכל עבר\n');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
