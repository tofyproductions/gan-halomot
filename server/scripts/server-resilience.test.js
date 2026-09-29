#!/usr/bin/env node
/**
 * The three ways this server could fail while still looking alive.
 *
 * All three were found on 29.09.2026 while chasing hanging tests, and all
 * three share a shape: the process stays up, the platform's health check keeps
 * passing, and nothing works.
 *
 *   1. A BROKEN LOG PIPE WEDGES THE PROCESS. On Render stdout is a pipe to the
 *      log collector. When it closes, writing raises EPIPE — and the write
 *      that raises it is inside the uncaughtException handler, which re-enters
 *      itself. Measured on a reproduction: 100% of a core, RSS climbing
 *      167 → 219MB, /api/health answering 200 in 23ms, and every other request
 *      hanging with no response ever sent. The health check keeps the instance
 *      in rotation while it serves nobody.
 *
 *   2. A BIND FAILURE IS SWALLOWED. app.listen emits 'error' with no listener,
 *      Node escalates it to uncaughtException, the handler logs it, and the
 *      process lives on holding memory, listening on nothing, exiting 0.
 *
 *   3. AN UNREACHABLE DATABASE TAKES A MINUTE TO SAY SO. No
 *      serverSelectionTimeoutMS on the main connection, so a request was
 *      measured taking 60s to fail — past anything a browser or proxy waits.
 *
 *   node scripts/server-resilience.test.js
 */
try { require.resolve('mongodb-memory-server'); } catch {
  console.error('\n❌  חסרה חבילת הבדיקה. הרץ:\n\n   npm install --no-save mongodb-memory-server\n');
  process.exit(1);
}

const { MongoMemoryServer } = require('mongodb-memory-server');
const { spawn, execSync } = require('child_process');
const http = require('http');
const path = require('path');

const PORT = 5441;
const B = `http://localhost:${PORT}`;
let failures = 0;
const ok = (cond, label, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${label}${!cond && detail ? `\n     ${detail}` : ''}`);
  if (!cond) failures++;
};

const INDEX = path.join(__dirname, '..', 'src', 'index.js');
// GC_REEXEC so the pid we hold is the server itself — see the API tests.
const envFor = (uri, port) => ({
  ...process.env, MONGODB_URI: uri, JWT_SECRET: 'resilience-test',
  PORT: String(port), NODE_ENV: 'test', DISABLE_JOBS: '1', GC_REEXEC: '1',
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 40000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if (await fn()) return true; } catch { /* not yet */ }
    await sleep(300);
  }
  return false;
};
const health = async () => {
  try {
    const r = await fetch(`${B}/api/health`, { signal: AbortSignal.timeout(3000) });
    return r.status;
  } catch { return 0; }
};
async function portIsFree(port) {
  try { await fetch(`http://localhost:${port}/api/health`, { signal: AbortSignal.timeout(1500) }); return false; }
  catch { return true; }
}

(async () => {
  if (!await portIsFree(PORT)) {
    console.error(`\n❌  משהו כבר מאזין על ${PORT}:\n\n   lsof -nP -iTCP:${PORT} -sTCP:LISTEN -t | xargs kill -9\n`);
    process.exit(1);
  }

  const mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri('resilience_test');
  const children = [];
  const cleanup = () => {
    for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  };
  process.on('exit', cleanup);

  try {
    console.log('\n🔌  צינור הלוג נסגר — השרת ממשיך לענות\n');
    {
      const srv = spawn(process.execPath, [INDEX], {
        env: envFor(uri, PORT), stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.push(srv);
      srv.stdout.on('data', () => {});
      srv.stderr.on('data', () => {});
      const up = await waitFor(async () => (await health()) === 200);
      ok(up, 'השרת עלה');

      if (up) {
        // Tear down OUR end of both pipes, then keep it working.
        //
        // HONEST LIMIT: this is a smoke check, not a reproduction. The wedge
        // needs a closed pipe AND an uncaught exception at the same moment, and
        // nothing reachable over HTTP raises one — express routes its errors
        // through the error handler instead. Verified by running this block
        // against the unfixed code, where it passed. So the discriminating
        // assertion is the source-level one below; this part only catches the
        // cruder regression where a closed log pipe takes the server down.
        srv.stdout.destroy();
        srv.stderr.destroy();

        for (let i = 0; i < 25; i++) {
          await fetch(`${B}/api/health`, { signal: AbortSignal.timeout(3000) }).catch(() => {});
          await fetch(`${B}/api/definitely-not-a-route-${i}`, { signal: AbortSignal.timeout(3000) }).catch(() => {});
        }
        await sleep(3000);

        ok((await health()) === 200, 'ועדיין עונה אחרי שהצינור נסגר');

        let cpu = 0;
        try { cpu = Number(execSync(`ps -o %cpu= -p ${srv.pid}`).toString().trim()) || 0; } catch { /* gone */ }
        ok(cpu < 50, `ולא נתקע בלולאה (CPU ${cpu}%)`,
          'מעל 50% כאן פירושו שמטפל הקריסה חוזר לעצמו — בדוק את logCrash ב-src/index.js');
      }
      srv.kill('SIGKILL');
      await sleep(500);
    }

    console.log('\n🚪  הפורט תפוס — השרת יוצא בשגיאה במקום להעמיד פנים\n');
    {
      const squatter = http.createServer((_, res) => res.writeHead(200).end('{}'));
      await new Promise((resolve) => squatter.listen(PORT, resolve));

      const srv = spawn(process.execPath, [INDEX], {
        env: envFor(uri, PORT), stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.push(srv);
      srv.stdout.on('data', () => {});
      srv.stderr.on('data', () => {});

      const exited = await new Promise((resolve) => {
        const t = setTimeout(() => resolve(null), 25000);
        srv.on('exit', (code) => { clearTimeout(t); resolve(code); });
      });
      ok(exited !== null, 'התהליך יצא במקום להישאר תלוי',
        'נשאר חי 25 שניות עם פורט תפוס — server.on(\'error\') חסר ב-src/index.js');
      ok(exited !== 0, `וביציאה שאומרת שנכשל (code ${exited})`,
        'יציאה ב-0 אומרת לפלטפורמה שהדיפלוי הצליח');

      await new Promise((resolve) => squatter.close(resolve));
    }

    console.log('\n🧯  מטפלי הקריסה לא יכולים לחזור לעצמם\n');
    {
      // The assertion that actually discriminates. The failure is a re-entry:
      // console.error throws EPIPE, the throw lands in uncaughtException, which
      // calls console.error. Nothing observable over HTTP distinguishes that
      // from a healthy process until it is already spinning, so what is pinned
      // here is the shape — a guarded write, and an error listener on each
      // stream so a later EPIPE is not an uncaught exception in its own right.
      const src = require('fs').readFileSync(INDEX, 'utf8');
      const handlers = /process\.on\('uncaughtException',([^\n]*)\)/.exec(src);
      ok(!!handlers, 'יש מטפל uncaughtException');
      ok(!!handlers && !/console\.(error|log)/.test(handlers[1]),
        'והוא לא כותב ללוג ישירות',
        'console.error בתוך המטפל זורק EPIPE על צינור סגור, והזריקה חוזרת למטפל — לולאה אינסופית');
      ok(/try\s*\{\s*console\.error[\s\S]{0,80}\}\s*catch/.test(src),
        'הכתיבה ללוג עטופה ב-try/catch');
      ok(/process\.stdout\.on\('error'/.test(src) && /process\.stderr\.on\('error'/.test(src),
        'ולשני הזרמים יש מטפל שגיאות משלהם',
        'בלעדיהם EPIPE בכתיבה מאוחרת הוא חריגה לא-תפוסה בפני עצמה');
    }

    console.log('\n⏱️   לחיבור מסד הנתונים יש תקרת זמן\n');
    {
      // Source-level, deliberately: the behaviour takes 20s of real waiting to
      // observe, and what must not regress is the OPTION — it was absent, and
      // absent it costs a full minute per request when Mongo is unreachable.
      const src = require('fs').readFileSync(
        path.join(__dirname, '..', 'src', 'config', 'database.js'), 'utf8');
      const m = /serverSelectionTimeoutMS:\s*([0-9_]+)/.exec(src);
      ok(!!m, 'connectDB קובע serverSelectionTimeoutMS',
        'בלעדיו ברירת המחדל של הדרייבר היא 30 שניות, ובפועל נמדדה בקשה של 60');
      if (m) {
        const ms = Number(String(m[1]).replace(/_/g, ''));
        ok(ms > 0 && ms <= 30000, `והתקרה סבירה (${ms}ms)`,
          'מעל 30 שניות זה כבר לא תקרה — זו ברירת המחדל בתחפושת');
      }
    }
  } finally {
    cleanup();
    await mongo.stop().catch(() => {});
  }

  console.log(failures ? `\n❌  ${failures} בדיקות נכשלו\n` : '\n✅  הכל עבר\n');
  process.exit(failures ? 1 : 0);
})();
