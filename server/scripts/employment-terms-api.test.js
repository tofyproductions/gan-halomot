#!/usr/bin/env node
/**
 * The terms endpoints against a real server, a real database and a real token.
 *
 * The unit suite proves the arithmetic; this proves the parts that only exist
 * once HTTP is involved and that would be worth nothing if wrong:
 *
 *   - a branch manager cannot read what anyone is paid, and cannot change it,
 *     even though the very same router lets her file that employee's contract
 *   - the change survives a save and comes back on the next request
 *   - a month already finalized is REPORTED, not silently repriced
 *
 * The permission half matters most. "רק הנהלת חשבונות" was a decision made in
 * conversation; without a test it is a comment, and the router it lives in
 * admits branch managers by design.
 *
 *   npm install --no-save mongodb-memory-server
 *   node scripts/employment-terms-api.test.js
 */
try { require.resolve('mongodb-memory-server'); } catch {
  console.error('\n❌  חסרה חבילת הבדיקה. הרץ:\n\n   npm install --no-save mongodb-memory-server\n');
  process.exit(1);
}

const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient, ObjectId } = require('mongodb');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');

const PORT = 5417;
const B = `http://localhost:${PORT}`;
const SECRET = 'terms-test-secret';
let failures = 0;

const ok = (cond, label) => { console.log(`  ${cond ? '✅' : '❌'} ${label}`); if (!cond) failures++; };
const eq = (a, b, label) => {
  const good = a === b;
  console.log(`  ${good ? '✅' : '❌'} ${label}${good ? '' : `  (קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)})`}`);
  if (!good) failures++;
};

async function api(pathname, { token, method = 'GET', body } = {}) {
  const res = await fetch(B + pathname, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null; try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}

const waitForServer = async (ms = 60000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await fetch(`${B}/api/health`); if (r.status < 500) return true; } catch { /* not up */ }
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
};

/**
 * A previous run that was killed mid-flight leaves its server child behind,
 * still holding PORT with a database that is already gone. The next run then
 * talks to that corpse and hangs on the first write instead of failing. Refuse
 * to start rather than produce a result nobody can trust.
 */
async function portIsFree() {
  try { await fetch(`${B}/api/health`, { signal: AbortSignal.timeout(1500) }); return false; }
  catch { return true; }
}

(async () => {
  if (!await portIsFree()) {
    console.error(`\n❌  משהו כבר מאזין על ${PORT} — כנראה שרת שנשאר מריצה קודמת. סגור אותו והרץ שוב:\n\n   lsof -nP -iTCP:${PORT} -sTCP:LISTEN -t | xargs kill -9\n`);
    process.exit(1);
  }
  const mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri('gan_terms_test');

  // --- seed -------------------------------------------------------------
  const client = await MongoClient.connect(uri);
  const db = client.db('gan_terms_test');

  const amutaId = new ObjectId();
  const branchId = new ObjectId();
  const empId = new ObjectId();

  await db.collection('amutas').insertOne({ _id: amutaId, name: 'עמותת בדיקה', tax_id: '580000000' });
  await db.collection('branches').insertOne({ _id: branchId, name: 'סניף בדיקה', amuta_id: amutaId });
  await db.collection('employees').insertOne({
    _id: empId,
    full_name: 'עובדת בדיקה',
    israeli_id: '123456782',
    branch_id: branchId,
    is_active: true,
    receives_salary: true,
    salary_type: 'hourly',
    start_date: new Date('2024-01-01'),
    amuta_distribution: [{ amuta_id: amutaId, hourly_rate: 52, global_salary: null, global_ot_rate: null, required_hours: null }],
    terms_history: [],
  });
  // A month already closed — the change must not claim to have moved it.
  await db.collection('payrollmonths').insertOne({
    branch_id: branchId, employee_id: empId, month: '2026-09', status: 'finalized', manual: {},
  });
  await client.close();

  const token = (role, extra = {}) => jwt.sign({
    id: String(new ObjectId()), full_name: role === 'accountant' ? 'הנהלת חשבונות' : 'מנהלת סניף',
    role, ...extra,
  }, SECRET, { expiresIn: '1h' });

  const accountant = token('accountant');
  const manager = token('branch_manager', { managed_branch_ids: [String(branchId)], branch_id: String(branchId) });

  // --- boot the server --------------------------------------------------
  const srv = spawn('node', ['src/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, MONGODB_URI: uri, JWT_SECRET: SECRET, PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  srv.stdout.on('data', d => log.push(String(d)));
  srv.stderr.on('data', d => log.push(String(d)));

  const done = (code) => { try { srv.kill('SIGKILL'); } catch { /* already gone */ } mongo.stop().finally(() => process.exit(code)); };
  // Ctrl-C or an outside kill must take the server child with it, or the next
  // run inherits the corpse described above.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => done(1));
  process.on('exit', () => { try { srv.kill('SIGKILL'); } catch { /* already gone */ } });

  if (!await waitForServer()) {
    console.error('❌  השרת לא עלה\n' + log.join(''));
    return done(1);
  }

  try {
    console.log('\n🔒  מנהלת סניף לא רואה ולא משנה שכר\n');
    {
      const read = await api(`/api/employment-contracts/terms/${empId}`, { token: manager });
      eq(read.status, 403, 'קריאת תנאי העסקה נחסמת למנהלת סניף');

      const write = await api('/api/employment-contracts/terms', {
        token: manager, method: 'POST',
        body: { employee_id: String(empId), effective_date: '2026-10-01', salary_type: 'hourly', hourly_rate: 99 },
      });
      eq(write.status, 403, 'ועדכון נחסם גם הוא');

      const preview = await api('/api/employment-contracts/terms/preview', {
        token: manager, method: 'POST',
        body: { employee_id: String(empId), effective_date: '2026-10-01', salary_type: 'hourly', hourly_rate: 99 },
      });
      eq(preview.status, 403, 'וגם התצוגה המקדימה — אחרת השכר דולף דרכה');
    }

    console.log('\n👀  הנהלת חשבונות רואה את המצב הקיים\n');
    {
      const r = await api(`/api/employment-contracts/terms/${empId}`, { token: accountant });
      eq(r.status, 200, 'הקריאה מותרת');
      eq(r.json?.current?.hourly_rate, 52, 'התעריף הנוכחי הוא של הכרטיס');
      eq((r.json?.history || []).length, 0, 'ואין עדיין היסטוריה');
    }

    console.log('\n🔍  תצוגה מקדימה אומרת את האמת לפני השמירה\n');
    {
      const r = await api('/api/employment-contracts/terms/preview', {
        token: accountant, method: 'POST',
        body: { employee_id: String(empId), effective_date: '2026-09-15', salary_type: 'hourly', hourly_rate: 60 },
      });
      eq(r.status, 200, 'התצוגה עוברת');
      eq(r.json?.effective_month, '2026-09', 'התאריך מתורגם לחודש');
      ok(r.json?.mid_month === true, 'ומסומן שהוא באמצע החודש');
      eq(r.json?.previous?.hourly_rate, 52, 'מציג מה היה');
      eq(r.json?.next?.hourly_rate, 60, 'ומה יהיה');
      ok((r.json?.finalized_months || []).includes('2026-09'), 'ומזהיר שספטמבר כבר סגור');

      const after = await api(`/api/employment-contracts/terms/${empId}`, { token: accountant });
      eq((after.json?.history || []).length, 0, 'ולא שמר כלום — זו רק תצוגה');
    }

    console.log('\n💾  השמירה נשמרת, עם שורת בסיס\n');
    {
      const r = await api('/api/employment-contracts/terms', {
        token: accountant, method: 'POST',
        body: {
          employee_id: String(empId), effective_date: '2026-10-01',
          salary_type: 'hourly', hourly_rate: 60, note: 'חוזה חדש חתום',
        },
      });
      eq(r.status, 201, 'נשמר');
      eq(r.json?.effective_month, '2026-10', 'בתוקף מאוקטובר');

      const after = await api(`/api/employment-contracts/terms/${empId}`, { token: accountant });
      eq((after.json?.history || []).length, 2, 'שתי שורות — בסיס וחדשה');
      eq(after.json?.current?.hourly_rate, 52, 'והחודש הנוכחי (אוגוסט) עדיין 52 ₪');

      const baseline = (after.json?.history || []).find(h => h.source === 'baseline');
      eq(baseline?.hourly_rate, 52, 'שורת הבסיס שמרה את התעריף הישן');

      const fresh = await api('/api/employment-contracts/terms/preview', {
        token: accountant, method: 'POST',
        body: { employee_id: String(empId), effective_date: '2026-11-01', salary_type: 'hourly', hourly_rate: 65 },
      });
      eq(fresh.json?.previous?.hourly_rate, 60, 'השינוי הבא משווה מול 60 ולא מול 52');
    }

    console.log('\n🚫  קלט פסול נדחה ולא נוגע בעובד\n');
    {
      const r = await api('/api/employment-contracts/terms', {
        token: accountant, method: 'POST',
        body: { employee_id: String(empId), effective_date: '2026-12-01', salary_type: 'hourly', hourly_rate: 0 },
      });
      eq(r.status, 400, 'תעריף 0 נדחה');

      const after = await api(`/api/employment-contracts/terms/${empId}`, { token: accountant });
      eq((after.json?.history || []).length, 2, 'ההיסטוריה לא גדלה');
    }
    console.log('\n📎  חוזה סרוק — מה נכנס ומה נדחה\n');
    {
      // The file is stored base64 inside the contract document, and MongoDB
      // stops at 16MB. Before the guard, an 12MB scan reached the driver and
      // came back as an English sentence about byte counts; bigger than ~17MB
      // never reached this code at all, and the manager saw a bare "שגיאה
      // בהעלאה" with nothing to act on.
      const pdf = (mb) => 'data:application/pdf;base64,'
        + Buffer.alloc(Math.round(mb * 1024 * 1024), 0x41).toString('base64');

      const small = await api('/api/employment-contracts/upload', {
        token: accountant, method: 'POST',
        body: { employee_id: String(empId), file_data: pdf(1), file_name: 'ok.pdf', file_mimetype: 'application/pdf' },
      });
      eq(small.status, 201, 'קובץ רגיל נשמר');

      const big = await api('/api/employment-contracts/upload', {
        token: accountant, method: 'POST',
        body: { employee_id: String(empId), file_data: pdf(12), file_name: 'big.pdf', file_mimetype: 'application/pdf' },
      });
      eq(big.status, 413, 'קובץ מעל התקרה נדחה ב-413 ולא קורס');
      ok(/גדול מדי/.test(big.json?.error || ''), 'וההסבר בעברית, עם הגודל והמקסימום');
      ok(!/size in bytes|BSON|MongoServerError/i.test(big.json?.error || ''),
        'ולא הודעת מנוע בסיס הנתונים');
    }
  } catch (err) {
    console.error('💥 ', err);
    failures++;
  }

  console.log(`\n${failures ? `❌  ${failures} בדיקות נכשלו\n` : '✅  הכל עבר\n'}`);
  done(failures ? 1 : 0);
})();
