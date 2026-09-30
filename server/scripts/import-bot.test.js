#!/usr/bin/env node
/**
 * The import bot's door.
 *
 * Neither Cibus nor ClickTac has an API, so a robot signs in to their sites,
 * downloads the monthly reports and posts the files to /api/import-bot. That
 * makes this the only write surface in the system reachable by something that
 * is not a person and holds no account, so the things worth proving are not the
 * imports — those already have their own suites — but the door:
 *
 *   CLOSED WHEN UNCONFIGURED. Without IMPORT_BOT_SECRET both routes answer 503
 *   and nothing else. A feature nobody switched on must not be reachable with a
 *   guess, and must not answer 401 either — "off" and "wrong key" send a person
 *   to two different places.
 *
 *   NO NAME REACHES THE CALLER. Both imports answer with names: the Cibus rows
 *   nobody matched, and ClickTac's missing/skipped/results lists. Those are
 *   employees and children, and the caller is a third party's robot that may
 *   log whatever it receives. The response is counts. This is asserted against
 *   the ACTUAL names in the fixture, and asserted from the other side too —
 *   the same names must still be in our own run log, where the accountant
 *   reads them.
 *
 *   A MONTH ALREADY IN IS REFUSED. Not for arithmetic — the import sets rather
 *   than adds — but because the accountant may have corrected a figure between
 *   the two runs, and the second would erase it silently.
 *
 *   CLICKTAC NEVER GUESSES A BRANCH. `מוסד` and `מעון` both read "כפר סבא" and
 *   two branches answer to it, so the file cannot say which gan it is. No
 *   branch, no import — a cohort filed into the wrong gan is not noticed fast.
 *
 *   EVERY KNOCK IS LOGGED, refusals included. A robot that stops working stops
 *   quietly.
 *
 *   npm install --no-save mongodb-memory-server
 *   node scripts/import-bot.test.js
 */
try { require.resolve('mongodb-memory-server'); } catch {
  console.error('\n❌  חסרה חבילת הבדיקה. הרץ:\n\n   npm install --no-save mongodb-memory-server\n');
  process.exit(1);
}

const { MongoMemoryServer } = require('mongodb-memory-server');
// Through mongoose, not the raw driver. `mongodb` is a NESTED dependency here
// (node_modules/mongoose/node_modules/mongodb), so a bare require('mongodb')
// resolves on a machine where npm happened to hoist it and fails on one where
// it did not. mongoose is a real dependency and is always there.
const mongoose = require('mongoose');
const { ObjectId } = mongoose.Types;
const { spawn } = require('child_process');
const crypto = require('crypto');
const XLSX = require('xlsx');
const ctrl = require('../src/controllers/importBot.controller');

const PORT = 5443;          // with a secret
const PORT_CLOSED = 5445;   // without one
const B = `http://localhost:${PORT}`;
const B_CLOSED = `http://localhost:${PORT_CLOSED}`;
const SECRET = 'import-bot-test-secret-at-least-32-chars-long';
const JWT_SECRET = 'import-bot-jwt-secret';

// Real-looking names, used as the needle in the leak assertions. If either of
// these ever appears in a response body, the reduction stopped working.
const MATCHED_NAME = 'רותי גלאם';
const UNMATCHED_NAME = 'שם שאינו עובדת';

let failures = 0;
const ok = (cond, label) => { console.log(`  ${cond ? '✅' : '❌'} ${label}`); if (!cond) failures++; };
const eq = (a, b, label) => {
  const good = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  ${good ? '✅' : '❌'} ${label}${good ? '' : `  (קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)})`}`);
  if (!good) failures++;
};

/** The three headers the door checks, signed the way sync.routes.js signs. */
function headers({ key = SECRET, ts = Math.floor(Date.now() / 1000), sig = null } = {}) {
  return {
    'x-import-key': key,
    'x-import-ts': String(ts),
    'x-import-sig': sig ?? crypto.createHmac('sha256', SECRET).update(`${ts}.`).digest('hex'),
  };
}

async function post(base, pathname, { file = null, fields = {}, hdrs = headers() } = {}) {
  const fd = new FormData();
  if (file) fd.append('file', new Blob([file.buffer]), file.name);
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  const res = await fetch(base + pathname, {
    method: 'POST', headers: hdrs, body: fd, signal: AbortSignal.timeout(20000),
  });
  let json = null; let text = '';
  try { text = await res.text(); json = JSON.parse(text); } catch { /* empty */ }
  return { status: res.status, json, text };
}

/** A Cibus export: one employee we hold, one row nobody matches. */
function cibusFile() {
  const aoa = [
    ['שם העובד/ת', 'ת"ז', 'הסכום שחוייב'],
    [MATCHED_NAME, '123456782', 142.5],
    [UNMATCHED_NAME, '999999999', 57.5],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'report');
  return { name: 'cibus.xlsx', buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) };
}

/**
 * A file that is neither ClickTac export: it carries two contract-only columns
 * and no id column, which is the WRONG_EXPORT_TYPE refusal. Enough to prove the
 * door forwards a refusal, logs it, and adds nothing of its own.
 */
function wrongExportFile() {
  const aoa = [['שכר לימוד', 'דרגה', 'מעון'], [1200, 3, 'כפר סבא']];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'sheet1');
  return { name: 'not-clicktac.xlsx', buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) };
}

/**
 * A minimal but REAL ClickTac registrations export: the six columns
 * `missingColumns` requires, and nothing else. The point is the success branch —
 * a file that actually writes a child — because that is the path where a name
 * could leak into the response.
 */
const CHILD_FIRST = 'ילדבדיקה';
const CHILD_LAST = 'משפחתבדיקה';
function clicktacFile() {
  const aoa = [
    ['מוסד', 'שנת לימודים', 'שם פרטי של הנרשם', 'שם משפחה של הנרשם', 'ת.ז הנרשם', 'תאריך לידה', 'טלפון של הרושם הראשון'],
    ['כפר סבא', 'תשפ״ז', CHILD_FIRST, CHILD_LAST, '300000001', '01/03/2024', '0501111111'],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'registrations');
  return { name: 'registrations.xlsx', buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) };
}

const waitFor = async (base, ms = 60000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await fetch(`${base}/api/health`); if (r.status < 500) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
};
async function portIsFree(base, port) {
  try { await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) }); return false; }
  catch { return true; }
}

/** 'YYYY-MM' in Israel, and the month before it — what the bot writes into. */
function months() {
  const cur = String(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date())).slice(0, 7);
  const [y, m] = cur.split('-').map(Number);
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  return { cur, prev };
}

(async () => {
  console.log('\n🧮  פונקציות טהורות — בלי שרת\n');
  {
    // The reduction is the whole privacy rule, so it is asserted directly
    // against a body shaped like the real one, names and all.
    const real = {
      branch: 'כפר סבא - קפלן',
      export_type: 'registrations',
      export_label: 'ייצוא הנרשמים',
      rows: 77, parsed: 77, created: 70, updated: 5, unchanged: 2,
      missing: 1, missing_names: ['נדיה גרוס'],
      skipped_duplicate: 1, skipped_names: ['ילד כפול'],
      restored: 1, restored_names: ['ילד שחזר'],
      results: [{ name: 'רוני לוי', id_number: '300000000' }],
      import_id: new ObjectId(),
    };
    const out = ctrl.reduceClicktac(real);
    const blob = JSON.stringify(out);
    ok(!blob.includes('נדיה'), 'reduceClicktac: שם של ילד/ה חסר/ה לא עובר');
    ok(!blob.includes('ילד כפול'), 'reduceClicktac: שם שנדחה לא עובר');
    ok(!blob.includes('ילד שחזר'), 'reduceClicktac: שם שהוחזר לא עובר');
    ok(!blob.includes('רוני'), 'reduceClicktac: results לא עובר');
    ok(!blob.includes('300000000'), 'reduceClicktac: ת"ז לא עוברת');
    eq([out.created, out.updated, out.unchanged, out.missing], [70, 5, 2, 1], 'reduceClicktac: הספירות כן עוברות');
    ok(typeof out.import_id === 'string' && out.import_id.length === 24, 'reduceClicktac: מזהה הביטול עובר כמחרוזת');
  }
  {
    const { cur, prev } = months();
    eq(ctrl.monthOutOfRange(prev), null, `monthOutOfRange: ${prev} מותר`);
    eq(ctrl.monthOutOfRange(cur), null, `monthOutOfRange: ${cur} מותר`);
    ok(!!ctrl.monthOutOfRange('2026-13'), 'monthOutOfRange: חודש 13 נדחה');
    ok(!!ctrl.monthOutOfRange('202609'), 'monthOutOfRange: בלי מקף נדחה');
    ok(!!ctrl.monthOutOfRange('2099-01'), 'monthOutOfRange: חודש עתידי נדחה');
    // The typo this guard exists for: last year's same month, which would
    // rewrite a payroll that closed and that nobody reads again.
    const [y, m] = prev.split('-');
    ok(!!ctrl.monthOutOfRange(`${Number(y) - 1}-${m}`), 'monthOutOfRange: אותו חודש שנה אחורה נדחה');
  }

  for (const [base, port] of [[B, PORT], [B_CLOSED, PORT_CLOSED]]) {
    if (!await portIsFree(base, port)) {
      console.error(`\n❌  משהו כבר מאזין על ${port}:\n\n   lsof -nP -iTCP:${port} -sTCP:LISTEN -t | xargs kill -9\n`);
      process.exit(1);
    }
  }

  const mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri('gan_import_bot_test');
  await mongoose.connect(uri, { dbName: 'gan_import_bot_test' });
  const db = mongoose.connection.db;

  const branchId = new ObjectId();
  const amutaId = new ObjectId();
  await db.collection('branches').insertOne({
    _id: branchId, name: 'כפר סבא - קפלן', amuta_id: amutaId, is_active: true,
  });
  await db.collection('employees').insertOne({
    _id: new ObjectId(), full_name: MATCHED_NAME, israeli_id: '123456782',
    branch_id: branchId, is_active: true,
  });

  const spawnServer = (port, withSecret) => spawn('node', ['src/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MONGODB_URI: uri,
      JWT_SECRET,
      PORT: String(port),
      NODE_ENV: 'test',
      // No re-exec: src/index.js relaunches itself with --expose-gc, which
      // makes the real listener a grandchild that SIGKILL cannot reach — and
      // the orphan keeps the port for every run after this one.
      GC_REEXEC: '1',
      // Nothing here should touch the mailbox or send a real email.
      DISABLE_JOBS: '1',
      // The hourly cap is a production figure (40); this file makes more
      // requests than that on purpose, since most of them are refusals.
      IMPORT_BOT_RATE_MAX: '500',
      ...(withSecret ? { IMPORT_BOT_SECRET: SECRET } : { IMPORT_BOT_SECRET: '' }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const log = [];
  const srv = spawnServer(PORT, true);
  const srvClosed = spawnServer(PORT_CLOSED, false);
  for (const s of [srv, srvClosed]) {
    s.stdout.on('data', (d) => log.push(String(d)));
    s.stderr.on('data', (d) => log.push(String(d)));
  }
  const killAll = () => { for (const s of [srv, srvClosed]) { try { s.kill('SIGKILL'); } catch { /* gone */ } } };
  const done = (code) => {
    killAll();
    mongoose.disconnect().catch(() => {}).finally(() => mongo.stop().finally(() => process.exit(code)));
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => done(1));
  process.on('exit', killAll);

  if (!await waitFor(B)) { console.error('❌  השרת לא עלה\n' + log.join('')); return done(1); }
  if (!await waitFor(B_CLOSED)) { console.error('❌  השרת ללא סוד לא עלה\n' + log.join('')); return done(1); }

  try {
    const { cur, prev } = months();

    console.log('\n🚪  בלי סוד — הדלת סגורה, לא מנחשת\n');
    for (const route of ['cibus', 'clicktac']) {
      const r = await post(B_CLOSED, `/api/import-bot/${route}`, { file: cibusFile() });
      eq(r.status, 503, `${route}: 503 כשהסוד לא מוגדר`);
      eq(r.json?.error?.code, 'NOT_CONFIGURED', `${route}: הקוד אומר "לא הוגדר", לא "מפתח שגוי"`);
    }
    {
      // The secret is the whole authentication, so a short one is not a weak
      // password — it is an open door, and the route stays shut.
      const r = await post(B_CLOSED, '/api/import-bot/cibus', {
        file: cibusFile(), hdrs: headers({ key: 'short' }),
      });
      eq(r.status, 503, 'מפתח קצר מ-32 תווים לא פותח דבר');
    }

    console.log('\n🔐  אימות\n');
    {
      const r = await post(B, '/api/import-bot/cibus', {
        file: cibusFile(), hdrs: headers({ key: 'x'.repeat(SECRET.length) }),
      });
      eq(r.status, 401, 'מפתח שגוי באותו אורך — 401');
      eq(r.json?.error?.code, 'UNAUTHORIZED', 'ובקוד הנכון');
    }
    {
      const stale = Math.floor(Date.now() / 1000) - 3600;
      const r = await post(B, '/api/import-bot/cibus', {
        file: cibusFile(),
        hdrs: {
          'x-import-key': SECRET,
          'x-import-ts': String(stale),
          'x-import-sig': crypto.createHmac('sha256', SECRET).update(`${stale}.`).digest('hex'),
        },
      });
      eq(r.status, 401, 'חותמת זמן מלפני שעה נדחית — בקשה שנשמרה לא תרוץ מחר');
      eq(r.json?.error?.code, 'STALE', 'ובקוד הנכון');
    }
    {
      const r = await post(B, '/api/import-bot/cibus', {
        file: cibusFile(), hdrs: headers({ sig: 'a'.repeat(64) }),
      });
      eq(r.status, 401, 'חתימה שגויה נדחית');
      eq(r.json?.error?.code, 'BAD_SIGNATURE', 'ובקוד הנכון');
    }
    {
      const r = await post(B, '/api/import-bot/cibus', {});
      eq(r.status, 400, 'בלי קובץ — 400');
      eq(r.json?.error?.code, 'NO_FILE', 'ובקוד הנכון');
    }

    console.log('\n🍽  סיבוס — הייבוא, והמידע שלא יוצא\n');
    {
      const r = await post(B, '/api/import-bot/cibus', { file: cibusFile() });
      eq(r.status, 200, 'הדוח יובא');
      eq(r.json?.month, prev, 'ובחודש הקודם — הקובץ של ה-1 בחודש הוא של החודש שעבר');
      eq(r.json?.matched, 1, 'עובדת אחת הותאמה');
      eq(r.json?.unmatched, 1, 'ושורה אחת לא');

      // The assertion this whole door is shaped around.
      ok(!r.text.includes(MATCHED_NAME), 'שם העובדת שהותאמה לא מופיע בתשובה');
      ok(!r.text.includes(UNMATCHED_NAME), 'שם השורה שלא הותאמה לא מופיע בתשובה');
      ok(!r.text.includes('123456782'), 'ת"ז לא מופיעה בתשובה');
      ok(!r.text.includes('142.5'), 'גם לא סכום של אדם מסוים');

      const pm = await db.collection('payrollmonths').findOne({ month: prev });
      eq(pm?.manual?.cibus?.amount, 142.5, 'הסכום כן נכתב לחודש השכר של העובדת');

      // And from the other side: the names we refuse to hand out are exactly
      // the ones the accountant must still be able to read.
      const sync = await db.collection('cibussyncs').findOne({ key: 'cibus' });
      eq(sync?.last_success_month, prev, 'יומן סיבוס מעודכן — וזה מה שמונע ייבוא כפול מהמייל ב-2 בחודש');
      eq(sync?.runs?.[0]?.trigger, 'bot', 'הריצה רשומה כ"בוט", לא כתזמון ולא כאדם');
      eq(sync?.runs?.[0]?.unmatched?.[0]?.name, UNMATCHED_NAME, 'והשם שלא הותאם שמור אצלנו, במקום שבו רואים אותו');

      const runs = await db.collection('importbotruns').find({ kind: 'cibus' }).toArray();
      eq(runs.filter(x => x.status === 'ok').length, 1, 'ויש שורה אחת ביומן הבוט');
      ok(!JSON.stringify(runs).includes(UNMATCHED_NAME), 'שגם הוא לא מחזיק שמות');
    }
    {
      const before = await db.collection('importbotruns').countDocuments({ status: 'rejected' });
      const r = await post(B, '/api/import-bot/cibus', { file: cibusFile() });
      eq(r.status, 409, 'העלאה שנייה לאותו חודש נדחית');
      eq(r.json?.error?.code, 'ALREADY_IMPORTED', 'בקוד שאומר לבוט "זה נעשה, תפסיק"');
      const after = await db.collection('importbotruns').countDocuments({ status: 'rejected' });
      eq(after - before, 1, 'והסירוב תועד — סירוב הוא הבוט מספר לנו שהוא ניסה');
    }
    {
      const r = await post(B, '/api/import-bot/cibus', { file: cibusFile(), fields: { force: '1' } });
      eq(r.status, 200, 'force=1 כן כותב מחדש — העקיפה של המשרד');
    }
    {
      const r = await post(B, '/api/import-bot/cibus', { file: cibusFile(), fields: { month: '2099-01' } });
      eq(r.status, 400, 'חודש עתידי נדחה');
      eq(r.json?.error?.code, 'BAD_MONTH', 'ובקוד הנכון');
    }
    {
      const r = await post(B, '/api/import-bot/cibus', { file: cibusFile(), fields: { month: `${cur}-99` } });
      eq(r.status, 400, 'חודש בתבנית שגויה נדחה');
    }

    console.log('\n🏫  קליקטאק — הסניף לא מנוחש\n');
    {
      const before = await db.collection('externalenrollments').countDocuments({});
      const r = await post(B, '/api/import-bot/clicktac', { file: wrongExportFile() });
      eq(r.status, 400, 'בלי סניף — סירוב');
      eq(r.json?.error?.code, 'NO_BRANCH', 'ובקוד שאומר בדיוק מה חסר');
      const after = await db.collection('externalenrollments').countDocuments({});
      eq(after - before, 0, 'ואף שורה לא נכתבה');
      const runs = await db.collection('importbotruns').find({ kind: 'clicktac' }).toArray();
      eq(runs.length, 1, 'הסירוב תועד');
      eq(runs[0].status, 'rejected', 'כסירוב');
    }
    {
      const r = await post(B, '/api/import-bot/clicktac', {
        file: wrongExportFile(), fields: { branch_id: new ObjectId().toString() },
      });
      eq(r.status, 404, 'סניף שלא קיים — 404');
      eq(r.json?.error?.code, 'BRANCH_NOT_FOUND', 'ובקוד הנכון');
    }
    {
      const r = await post(B, '/api/import-bot/clicktac', {
        file: wrongExportFile(), fields: { branch_id: branchId.toString() },
      });
      eq(r.status, 400, 'קובץ שאינו אחד משני הייצואים נדחה');
      // The refusal travels — the bot has to be able to tell a wrong file from
      // a wrong key — but it travels as a code and a message about the FILE.
      ok(/ייצוא/.test(r.json?.error?.message || ''), 'וההודעה אומרת שזה הקובץ הלא נכון');
      const runs = await db.collection('importbotruns').find({ kind: 'clicktac', status: 'rejected' }).toArray();
      eq(runs.length, 3, 'שלושת הסירובים תועדו, כל אחד עם הסיבה שלו');
      ok(runs.every(x => x.branch_id == null || String(x.branch_id) === branchId.toString()),
        'ואף שורה לא נרשמה על סניף שלא נבחר');
    }

    console.log('\n🏫  קליקטאק — ייבוא אמיתי, והמידע שלא יוצא\n');
    {
      const r = await post(B, '/api/import-bot/clicktac', {
        file: clicktacFile(), fields: { branch_id: branchId.toString() },
      });
      eq(r.status, 200, 'ייצוא הנרשמים יובא');
      eq(r.json?.export_type, 'registrations', 'והמערכת זיהתה איזה משני הייצואים זה');
      eq(r.json?.created, 1, 'נוצרה שורה אחת');

      // The success branch is the one that writes a child, so it is the one
      // where a name would actually be worth leaking.
      ok(!r.text.includes(CHILD_FIRST), 'שם הילד/ה לא מופיע בתשובה לבוט');
      ok(!r.text.includes(CHILD_LAST), 'גם לא שם המשפחה');
      ok(!r.text.includes('300000001'), 'וגם לא ת"ז');
      ok(!r.text.includes('0501111111'), 'וגם לא טלפון של הורה');
      ok(!('results' in (r.json || {})) && !('missing_names' in (r.json || {})),
        'שדות השמות של הייבוא לא קיימים בתשובה בכלל');

      const rows = await db.collection('externalenrollments')
        .find({ branch_id: branchId }).toArray();
      eq(rows.length, 1, 'והשורה כן נכתבה אצלנו');
      eq(rows[0]?.branch_id?.toString(), branchId.toString(), 'על הסניף שנאמר במפורש, לא על סניף שנוחש');
      eq(rows[0]?.imported_by ?? null, null, 'imported_by ריק — לבוט אין חשבון והוא לא מתחזה לאדם');

      ok(!!r.json?.import_id, 'התשובה מחזירה מזהה ביטול');
      const logged = await db.collection('importbotruns')
        .findOne({ kind: 'clicktac', status: 'ok' });
      eq(logged?.enrollment_import_id?.toString(), r.json.import_id, 'שנשמר ביומן הבוט כדי שאפשר יהיה לבטל');
      eq(logged?.branch_name, 'כפר סבא - קפלן', 'והיומן אומר לאיזה סניף זה נכנס');
      eq(logged?.counts?.created, 1, 'ואת הספירה');
      ok(!JSON.stringify(logged).includes(CHILD_FIRST), 'גם יומן הבוט לא מחזיק שמות');
    }
  } catch (e) {
    console.error('\n❌  נפילה:', e.message, '\n', e.stack, '\n' + log.slice(-20).join(''));
    failures++;
  }

  console.log(failures ? `\n❌  ${failures} כשלונות\n` : '\n✅  הכל עבר\n');
  return done(failures ? 1 : 0);
})();
