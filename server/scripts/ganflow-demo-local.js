#!/usr/bin/env node
/**
 * Run the whole demo on this laptop, offline, with one command.
 *
 * WHY OFFLINE MATTERS: a sales evening runs on a room's wifi, and the free
 * hosting tier sleeps after fifteen minutes and takes about a minute to wake.
 * Neither is something to discover in front of a room of gan managers. This
 * needs no network once it has started, and nothing here ever touches the
 * hosted demo — it is the fallback that cannot be taken away by the venue.
 *
 * What it does:
 *   1. starts a MongoDB on this machine (installing the binary once if needed)
 *   2. clones production into it and scrambles it, in one step
 *   3. starts the API with the scheduled jobs OFF
 *   4. prints the address and the login, and waits until Ctrl-C
 *
 * Usage, from the server/ directory:
 *   node scripts/ganflow-demo-local.js
 *   node scripts/ganflow-demo-local.js --port 5088 --keep    # reuse yesterday's demo
 *
 * --keep skips the rebuild and starts the demo that is already on disk. Use it
 * on the night itself: rebuilding needs the internet and the production
 * database, and the demo is deterministic, so yesterday's is the same demo you
 * rehearsed with.
 */

const path = require('path');
const fs = require('fs');
const { execFileSync, spawn } = require('child_process');
require('dotenv').config();

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? d : argv[i + 1];
};
const PORT = Number(opt('port', 5088));
const DB_PORT = Number(opt('db-port', 27077));
const KEEP = argv.includes('--keep');

const DATA = path.join(__dirname, '..', '.demo-data');
const DB_URI = `mongodb://127.0.0.1:${DB_PORT}/ganflow_demo`;

function die(m) { console.error(`\n❌  ${m}\n`); process.exit(1); }

if (!KEEP && !process.env.MONGODB_URI) {
  die('חסר MONGODB_URI בקובץ server/.env — בלעדיו אין מאיפה לשכפל.\n' +
      '   אם כבר בנית את הדמו פעם אחת, הרץ עם --keep.');
}

// ------------------------------------------------------------------ mongod

// mongodb-memory-server is not a dependency (see the note in the test), but it
// is the least painful way to get a mongod onto a laptop that has none.
let MongoMemoryServer;
try {
  ({ MongoMemoryServer } = require('mongodb-memory-server'));
} catch {
  console.log('\n\u{1F4E6}  מתקין רכיב מסד נתונים מקומי (פעם אחת בלבד)...\n');
  try {
    execFileSync('npm', ['install', '--no-save', 'mongodb-memory-server'], {
      cwd: path.join(__dirname, '..'), stdio: 'inherit',
    });
    ({ MongoMemoryServer } = require('mongodb-memory-server'));
  } catch {
    die('ההתקנה נכשלה. צריך חיבור לאינטרנט פעם אחת כדי להתקין. נסה:\n' +
        '   npm install --no-save mongodb-memory-server');
  }
}

let mongo, api;
let shuttingDown = false;

async function stop(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n\u{1F6D1}  מכבה...');
  if (api && !api.killed) api.kill('SIGTERM');
  if (mongo) { try { await mongo.stop(); } catch { /* already gone */ } }
  process.exit(code);
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

(async () => {
  fs.mkdirSync(DATA, { recursive: true });

  console.log('\n\u{1F5C4}️   מפעיל מסד נתונים מקומי...');
  mongo = await MongoMemoryServer.create({
    instance: { port: DB_PORT, dbPath: DATA, storageEngine: 'wiredTiger' },
  });

  if (KEEP) {
    console.log('\u{267B}️   --keep: משתמש בדמו שכבר בנוי, בלי לבנות מחדש.');
  } else {
    console.log('\u{1F3D7}️   בונה את הדמו (משכפל ומערבל)...\n');
    try {
      execFileSync(process.execPath, [path.join(__dirname, 'ganflow-demo-build.js'), '--to', DB_URI],
        { stdio: 'inherit' });
    } catch {
      await stop(1);
      return;
    }
  }

  console.log('\n\u{1F680}  מפעיל את המערכת...\n');
  api = spawn(process.execPath, ['--expose-gc', '--max-old-space-size=256', path.join(__dirname, '..', 'src', 'index.js')], {
    env: {
      ...process.env,
      MONGODB_URI: DB_URI,
      JWT_SECRET: process.env.JWT_SECRET || 'ganflow-demo-local',
      DISABLE_JOBS: '1',        // never a mailbox, a sheet or a paid scan from a demo
      NODE_ENV: 'production',
      PORT: String(PORT),
    },
    stdio: 'inherit',
  });

  api.on('exit', (code) => {
    if (!shuttingDown) {
      console.error(`\n❌  השרת נסגר (קוד ${code}).\n`);
      stop(code || 1);
    }
  });

  setTimeout(() => {
    console.log('\n' + '─'.repeat(56));
    console.log(`  הדמו רץ:   http://localhost:${PORT}`);
    console.log('  כניסה:     שם מלא + תעודת זהות, ואז סיסמה');
    console.log('  הסיסמה:    Demo2026!');
    console.log('');
    console.log('  לא צריך אינטרנט מכאן והלאה.');
    console.log('  לעצירה: Ctrl-C');
    console.log('─'.repeat(56) + '\n');
  }, 4000);
})().catch(async (e) => {
  console.error(`\n❌  ${e.message}\n`);
  await stop(1);
});
