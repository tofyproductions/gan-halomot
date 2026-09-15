#!/usr/bin/env node
/**
 * The board boots the way RENDER boots it — in production, with none of the
 * gan's variables present.
 *
 * WHY THIS EXISTS. jobgan-e2e spawns the server with NODE_ENV=development,
 * because that is what a test wants. config/env.js only refuses a missing
 * JWT_SECRET *in production*, so 54 green assertions said nothing about the
 * one thing that actually failed: on Render the service exited before it
 * listened, demanding the gan's signing key, because mail.js imported
 * services/email.service.js which imports config/env.js.
 *
 * The separation between this service and the gan is a claim made in a commit
 * message and enforced by nothing. This is the enforcement: production mode,
 * an environment holding ONLY the JOBGAN_* variables, and the server has to
 * come up and answer.
 *
 *   node scripts/jobgan-boot.test.js
 */
try { require.resolve('mongodb-memory-server'); } catch {
  console.error('\n❌  חסרה חבילת הבדיקה: npm install --no-save mongodb-memory-server\n');
  process.exit(1);
}

const { MongoMemoryServer } = require('mongodb-memory-server');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 5437;
const B = `http://localhost:${PORT}`;
let failures = 0;
const ok = (c, label, detail = '') => {
  console.log(`  ${c ? '✅' : '❌'} ${label}${!c && detail ? `\n     ${detail}` : ''}`);
  if (!c) failures++;
};

(async () => {
  const mongo = await MongoMemoryServer.create();
  const uri = `${mongo.getUri()}jobgan_boot`;

  /**
   * Built from nothing rather than from process.env. Inheriting the parent's
   * environment is exactly how this bug hid: the developer's shell has
   * JWT_SECRET in it, Render does not.
   */
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: 'production',
    JOBGAN_MONGODB_URI: uri,
    JOBGAN_JWT_SECRET: 'jobgan-boot-secret-at-least-16',
    JOBGAN_ADMIN_SECRET: 'jobgan-boot-admin-secret-16chars',
    JOBGAN_PORT: String(PORT),
    JOBGAN_PUBLIC_URL: 'https://jobs.example.invalid',
  };

  /**
   * cwd is a scratch directory, and that detail is the difference between this
   * test working and this test lying.
   *
   * config/env.js calls dotenv, which reads `.env` from the CURRENT DIRECTORY.
   * Run from server/ — where a developer's .env sits, holding JWT_SECRET — the
   * broken import loads fine and the test passes. Render has no .env file, so
   * the same code exits on boot. The first version of this test ran from
   * server/ and reported green against the exact bug it was written for.
   */
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jobgan-boot-'));
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'jobgan', 'index.js')], {
    env, cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  server.stdout.on('data', d => { out += d; });
  server.stderr.on('data', d => { out += d; });

  const stop = async () => { server.kill('SIGTERM'); await mongo.stop().catch(() => {}); };

  const up = await (async () => {
    const until = Date.now() + 40000;
    while (Date.now() < until) {
      if (server.exitCode !== null) return false;
      try { if ((await fetch(`${B}/api/health`)).ok) return true; } catch { /* not yet */ }
      await new Promise(r => setTimeout(r, 400));
    }
    return false;
  })();

  console.log('\n--- עלייה במצב ייצור, בלי משתני הגן ---');
  ok(up, 'השרת עלה', out.slice(-600));

  if (up) {
    const h = await (await fetch(`${B}/api/health`)).json();
    ok(h.service === 'jobgan', 'ומזהה את עצמו כ-jobgan');

    const meta = await (await fetch(`${B}/api/meta`)).json();
    ok(Array.isArray(meta.areas) && meta.areas.length === 6, 'והרשימות נטענות');

    const jobs = await (await fetch(`${B}/api/jobs`)).json();
    ok(Array.isArray(jobs.jobs), 'והלוח עונה');

    // The whole point: nothing dragged the gan's config in behind it.
    ok(!/JWT_SECRET/.test(out), '⚠️  ולא נדרש JWT_SECRET של הגן', out.slice(-400));
  }

  await stop();
  console.log(failures ? `\n❌  ${failures} כשלונות\n` : '\n🎉 עבר\n');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
