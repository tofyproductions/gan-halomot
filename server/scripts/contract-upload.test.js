#!/usr/bin/env node
/**
 * A signed contract that is bigger than a database row.
 *
 * A scan from a phone is routinely 12–20MB. Stored base64 inside the contract
 * document it cannot be: a MongoDB document stops at 16MB and base64 costs a
 * third on top, so the driver answered "object to insert too large. size in
 * bytes: 16777864" and the manager was shown that sentence, in English, about
 * a file she had just waited to upload.
 *
 * So the file goes to object storage and the document keeps the key. This
 * pins both halves of that, because only one of them is the interesting one:
 *
 *   - with a bucket, a 15MB scan uploads, and comes back out byte-for-byte
 *   - without a bucket, the old ceiling still applies and the refusal SAYS
 *     that the bucket is why, instead of blaming the file
 *
 * The bucket here is a forty-line stand-in that speaks enough S3 for the SDK
 * to sign against. It is not a test of Cloudflare; it is a test that this code
 * puts the bytes somewhere other than the document and can read them back.
 *
 *   npm install --no-save mongodb-memory-server
 *   node scripts/contract-upload.test.js
 */
try { require.resolve('mongodb-memory-server'); } catch {
  console.error('\n❌  חסרה חבילת הבדיקה. הרץ:\n\n   npm install --no-save mongodb-memory-server\n');
  process.exit(1);
}

const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient, ObjectId } = require('mongodb');
const { spawn } = require('child_process');
const http = require('http');
const jwt = require('jsonwebtoken');

const PORT = 5419;          // with a bucket
const PORT_NO_BUCKET = 5421; // without one
const BUCKET_PORT = 5420;
let B = `http://localhost:${PORT}`;
const SECRET = 'contract-upload-secret';
let failures = 0;

const ok = (cond, label) => { console.log(`  ${cond ? '✅' : '❌'} ${label}`); if (!cond) failures++; };
const eq = (a, b, label) => {
  const good = a === b;
  console.log(`  ${good ? '✅' : '❌'} ${label}${good ? '' : `  (קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)})`}`);
  if (!good) failures++;
};

/** Enough S3 for the SDK to PUT into and for a signed GET to read back. */
function startBucket() {
  const objects = new Map();
  const server = http.createServer((req, res) => {
    const key = req.url.split('?')[0];
    if (req.method === 'PUT') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        objects.set(key, Buffer.concat(chunks));
        res.writeHead(200, { ETag: '"stub"' }).end();
      });
      return;
    }
    if (req.method === 'GET' && objects.has(key)) {
      const body = objects.get(key);
      res.writeHead(200, { 'Content-Length': body.length }).end(body);
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(BUCKET_PORT, () => resolve({ server, objects })));
}

async function api(pathname, { token, method = 'GET', body, raw } = {}) {
  const res = await fetch(B + pathname, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body && !raw ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: raw ? body : JSON.stringify(body) } : {}),
  });
  return res;
}

const waitForServer = async (ms = 60000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await fetch(`${B}/api/health`); if (r.status < 500) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
};

async function portIsFree() {
  try { await fetch(`${B}/api/health`, { signal: AbortSignal.timeout(1500) }); return false; }
  catch { return true; }
}

/** Boot the app against `uri`, with or without a bucket in its environment. */
function boot(uri, withBucket, port) {
  const bucketEnv = withBucket ? {
    STORAGE_ENDPOINT: `http://localhost:${BUCKET_PORT}`,
    STORAGE_REGION: 'auto',
    STORAGE_ACCESS_KEY_ID: 'test-key',
    STORAGE_SECRET_ACCESS_KEY: 'test-secret',
    STORAGE_BUCKET: 'contracts-test',
  } : {
    STORAGE_ENDPOINT: '', STORAGE_ACCESS_KEY_ID: '', STORAGE_SECRET_ACCESS_KEY: '',
    STORAGE_BUCKET: '', R2_ACCOUNT_ID: '', R2_ACCESS_KEY_ID: '', R2_SECRET_ACCESS_KEY: '', R2_BUCKET: '',
  };
  return spawn('node', ['src/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, MONGODB_URI: uri, JWT_SECRET: SECRET, PORT: String(port), NODE_ENV: 'test', ...bucketEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const scan = (mb) => Buffer.alloc(Math.round(mb * 1024 * 1024), 0x41);

function formFor(buf, empId, filename = 'scan.pdf') {
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'application/pdf' }), filename);
  form.append('employee_id', empId);
  return form;
}

(async () => {
  for (const port of [PORT, PORT_NO_BUCKET]) {
    B = `http://localhost:${port}`;
    if (!await portIsFree()) {
      console.error(`\n❌  משהו כבר מאזין על ${port} — כנראה שרת שנשאר מריצה קודמת:\n\n   lsof -nP -iTCP:${port} -sTCP:LISTEN -t | xargs kill -9\n`);
      process.exit(1);
    }
  }
  B = `http://localhost:${PORT}`;

  const { server: bucket, objects } = await startBucket();
  const mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri('gan_upload_test');

  const client = await MongoClient.connect(uri);
  const db = client.db('gan_upload_test');
  const amutaId = new ObjectId();
  const branchId = new ObjectId();
  const empId = new ObjectId();
  await db.collection('amutas').insertOne({ _id: amutaId, name: 'עמותת בדיקה' });
  await db.collection('branches').insertOne({ _id: branchId, name: 'סניף בדיקה', amuta_id: amutaId });
  await db.collection('employees').insertOne({
    _id: empId, full_name: 'עובדת בדיקה', israeli_id: '123456782', branch_id: branchId,
    is_active: true, salary_type: 'hourly',
    amuta_distribution: [{ amuta_id: amutaId, hourly_rate: 52 }],
  });
  await client.close();

  const token = jwt.sign({ id: String(new ObjectId()), full_name: 'הנהלת חשבונות', role: 'accountant' },
    SECRET, { expiresIn: '1h' });

  const servers = [];
  const done = async (code) => {
    for (const s of servers) { try { s.kill('SIGKILL'); } catch { /* gone */ } }
    bucket.close();
    mongo.stop().finally(() => process.exit(code));
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => done(1));
  process.on('exit', () => { for (const s of servers) { try { s.kill('SIGKILL'); } catch { /* gone */ } } });

  try {
    // ---------------------------------------------------------------------
    console.log('\n🪣  עם אחסון חיצוני — קובץ גדול עובר\n');
    servers.push(boot(uri, true, PORT));
    if (!await waitForServer()) { console.error('❌  השרת עם האחסון לא עלה'); return done(1); }

    let contractId = null;
    {
      const bytes = scan(15);
      const res = await api('/api/employment-contracts/upload',
        { token, method: 'POST', body: formFor(bytes, String(empId), 'חוזה חתום.pdf'), raw: true });
      const j = await res.json().catch(() => ({}));
      eq(res.status, 201, 'סריקה של 15MB נשמרת — מעל תקרת בסיס הנתונים');
      contractId = j.contract?.id;
      ok(objects.size === 1, 'והקובץ אכן נכתב לאחסון ולא למסמך');

      const stored = [...objects.values()][0];
      eq(stored?.length, bytes.length, 'ובגודל המקורי, בייט בבייט');
    }

    {
      // The document must NOT be carrying the bytes.
      const c2 = await MongoClient.connect(uri);
      const doc = await c2.db('gan_upload_test').collection('employmentcontracts').findOne({});
      await c2.close();
      ok(!doc?.uploaded_file?.data, 'המסמך בבסיס הנתונים לא מחזיק את הקובץ');
      ok(!!doc?.uploaded_file?.storage_key, 'אלא רק את המפתח שלו');
      eq(doc?.uploaded_file?.name, 'חוזה חתום.pdf', 'ושם הקובץ בעברית נשמר כמו שהוא');
    }

    {
      const res = await api(`/api/employment-contracts/${contractId}/file`, { token });
      eq(res.status, 200, 'והקובץ נפתח בחזרה דרך המערכת');
      const back = Buffer.from(await res.arrayBuffer());
      eq(back.length, scan(15).length, 'באותו גודל שהועלה');
      ok(back.equals(scan(15)), 'ובאותו תוכן');
    }

    {
      const res = await api('/api/employment-contracts/upload',
        { token, method: 'POST', body: formFor(scan(45), String(empId)), raw: true });
      const j = await res.json().catch(() => ({}));
      eq(res.status, 413, 'קובץ מעל 40MB עדיין נדחה');
      ok(/גדול מדי/.test(j.error || ''), 'בעברית');
    }

    // ---------------------------------------------------------------------
    console.log('\n📦  בלי אחסון חיצוני — התקרה הישנה חוזרת, ואומרת למה\n');
    servers.push(boot(uri, false, PORT_NO_BUCKET));
    B = `http://localhost:${PORT_NO_BUCKET}`;
    if (!await waitForServer()) { console.error('❌  השרת בלי האחסון לא עלה'); return done(1); }

    {
      const res = await api('/api/employment-contracts/upload',
        { token, method: 'POST', body: formFor(scan(2), String(empId)), raw: true });
      eq(res.status, 201, 'קובץ קטן עדיין נשמר — בתוך המסמך');
    }
    {
      const res = await api('/api/employment-contracts/upload',
        { token, method: 'POST', body: formFor(scan(15), String(empId)), raw: true });
      const j = await res.json().catch(() => ({}));
      eq(res.status, 413, 'קובץ של 15MB נדחה');
      ok(/אחסון/.test(j.error || ''), 'וההסבר אומר שהסיבה היא שהאחסון לא מוגדר, לא שהקובץ אשם');
      ok(!/size in bytes|MongoServerError|BSON/i.test(j.error || ''), 'ולא הודעת מנוע בסיס הנתונים');
    }
  } catch (err) {
    console.error('💥 ', err);
    failures++;
  }

  console.log(`\n${failures ? `❌  ${failures} בדיקות נכשלו\n` : '✅  הכל עבר\n'}`);
  done(failures ? 1 : 0);
})();
