#!/usr/bin/env node
/**
 * שני הייצואים של קליקטאק, דרך אותו כפתור, לשורה אחת לכל ילד/ה.
 *
 * THE STORY THIS TEST TELLS. בפורטל של קליקטאק יש שני דוחות ואף אחד מהם אינו
 * הילד/ה השלם/ה. ייצוא הנרשמים מביא את המשפחה — שני הורים, טלפונים, אמצעי
 * תשלום, הוראת קבע — ואין בו לא כיתה ולא דרגה. ייצוא החוזים מביא בדיוק את מה
 * שחסר שם — הכיתה שאליה שובצו, סוג המימון, הדרגה שממנה נגזר כל שכר הלימוד,
 * ותאריכי החוזה — ואין בו אף עמודת הורה.
 *
 * המשרד צריך את שניהם. עד עכשיו הדרגה נבחרה ידנית פעם אחת לכל קליטה והוחלה על
 * כל הילדים, כי היא פשוט לא הייתה בקובץ.
 *
 * WHAT MUST HOLD:
 *   1. הכותרות — ולא שם הקובץ — מחליטות איזה ייצוא זה. שם הקובץ משתנה בדרך.
 *   2. שורת חוזה מתפרשת נכון: תאריכי אקסל מספריים הופכים לתאריכים, ת"ז נשארת
 *      ספרות בלבד (ודרכון נשאר כמו שהוא), הדרגה נשמרת גם כשהיא 0.
 *   3. קליטת חוזים בלבד יוצרת שורות — עם כיתה ודרגה, בלי הורים — ואי אפשר
 *      לקלוט אותן למערכת: התשובה היא הודעה שאומרת בדיוק איזה קובץ חסר.
 *   4. קליטת הנרשמים אחר כך ממלאת את אותן שורות ולא יוצרת כפילות, וממנה
 *      והלאה אפשר לקלוט.
 *   5. וגם בסדר ההפוך — נרשמים ואז חוזים — יוצא אותו מספר שורות.
 *   6. קליטה חוזרת של אותו קובץ חוזים אינה משנה דבר.
 *
 * THE DATABASE IS EPHEMERAL AND LOCAL. mongodb-memory-server מריץ mongod אמיתי
 * בתיקייה זמנית, ו-dotenv מנוטרל לפני שמשהו טוען אותו — server/.env במכונה
 * הזאת מצביע על הפרודקשן ואסור שייקרא. תבנית ההרמה מועתקת מ-viewer-e2e.test.js.
 *
 *   node scripts/clicktac-contracts.test.js
 */
const net = require('net');
const http = require('http');

/* ------------------------------------------------------------------ *
 * 1. Nothing may read server/.env. Stub dotenv before anything loads it.
 * ------------------------------------------------------------------ */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};

const XLSX = require('xlsx');
const { MongoMemoryServer } = require('mongodb-memory-server');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

const {
  COLUMNS, detectExportType, parseContractsRow, parseDate, idKey,
} = require('../src/services/clicktac.service');

const PASSWORD = 'test1234';
const YEAR = 'תשפ"ז';

let failures = 0;
let checks = 0;

function ok(cond, label, detail = '') {
  checks++;
  if (cond) console.log(`  ✅ ${label}`);
  else { failures++; console.log(`  ❌ ${label}${detail ? `  (${detail})` : ''}`); }
  return !!cond;
}

const eq = (actual, expected, label) => ok(
  JSON.stringify(actual) === JSON.stringify(expected),
  label,
  `קיבלנו ${JSON.stringify(actual)}, ציפינו ${JSON.stringify(expected)}`,
);

const head = (t) => console.log(`\n${t}`);

/* ================================================================== *
 * The two files, built as real xlsx and read back the way importFile
 * reads an upload.
 *
 * The row builders live in scripts/lib/clicktac-fixtures.js — extracted, not
 * rewritten, because scripts/demo-clicktac-seed.js builds the demo database by
 * running the REAL importers over these same sheets. See the note at the top
 * of that file for why a hand-written mongoose document would not do.
 * ================================================================== */

const {
  excelSerial, sheetBuffer, CONTRACTS_HEADER, REGISTRATIONS_HEADER,
  contractRow, registrationRow,
} = require('./lib/clicktac-fixtures');

/** The three children both files share, plus one only the registrations has. */
const KIDS = [
  {
    id: '337198', first: 'אור', last: 'אבוחצירא', idNumber: '241111117', birth: [2025, 1, 20],
    cls: 'בוגרים א', tier: 0,
    // שלושת השדות שרק ייצוא החוזים ממלא. הכינוי הוא איך קוראים לה בכיתה,
    // וההערה הרפואית היא אלרגיה. אף אחד משלושתם אינו בייצוא הנרשמים.
    nickname: 'אורי', medicalNotes: 'אלרגיה לבוטנים',
  },
  { id: '337199', first: 'נועם', last: 'כהן', idNumber: '242222225', birth: [2025, 3, 5], cls: 'בוגרים ב', tier: 7 },
  { id: '337200', first: 'שירה', last: 'לוי', idNumber: '243333333', birth: [2024, 11, 2], cls: 'בוגרים א', tier: 12 },
];
const EXTRA_KID = { first: 'איתי', last: 'מזרחי', idNumber: '244444441', birth: [2025, 2, 14] };

const contractsFile = () => sheetBuffer(
  CONTRACTS_HEADER,
  KIDS.map(k => contractRow(k)),
  'Worksheet 1',
);

/**
 * צורת התשלום של כל משפחה — שלוש מהארבע צריכות טיפול.
 *
 * אור משלמת בכרטיס אשראי ואין עליה מה לומר. נועם במזומן, והגן אינו מקבל
 * מזומן. אצל שירה לא נבחר אמצעי תשלום בכלל. איתי בהוראת קבע — אמצעי שהגן מקבל
 * — אבל אף אחת מעמודות ההו"ק אינה מלאה בקובץ הזה, ולכן היא חסרה ולא שגויה.
 * הסדר הוא הסדר של KIDS ואז EXTRA_KID.
 */
const METHODS = ['כרטיס אשראי', 'מזומן', '', 'הו"ק'];

const registrationsFile = () => sheetBuffer(
  REGISTRATIONS_HEADER,
  [...KIDS, EXTRA_KID].map((k, i) => registrationRow({
    ...k, parentFirst: `הורה${i + 1}`, parentPhone: `05000000${i + 1}`,
    method: METHODS[i],
  })),
  'Sheet1',
);

/* ================================================================== *
 * HTTP plumbing (same shape as viewer-e2e.test.js)
 * ================================================================== */

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

let PORT = 0;

function request({ method = 'GET', path, token, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    let payload = null;
    if (body !== undefined && body !== null) {
      if (Buffer.isBuffer(body)) {
        payload = body;
      } else {
        payload = Buffer.from(JSON.stringify(body));
        h['Content-Type'] = h['Content-Type'] || 'application/json';
      }
      h['Content-Length'] = payload.length;
    }
    if (token) h.Authorization = `Bearer ${token}`;
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: json, text });
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Same as request(), but resolves the raw response Buffer instead of a utf8
 * string — request() decodes-then-reencodes as utf8, which corrupts a binary
 * body like an .xlsx workbook. Needed only for the export download in check 22.
 */
function requestBuffer({ method = 'GET', path, token, headers = {} }) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buffer: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

/** multipart/form-data, hand-built — the import route is behind multer. */
function upload({ token, path, fileName, buffer, fields = {} }) {
  const boundary = `----ganTest${Date.now()}`;
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8',
    ));
  }
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\n`
    + 'Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n',
    'utf8',
  ));
  parts.push(buffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return request({
    method: 'POST', path, token, body: Buffer.concat(parts),
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await request({ path: '/api/health' });
      if (r.status === 200) return true;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('השרת לא ענה על /api/health');
}

/* ================================================================== */

let mongod = null;
let server = null;

/* ---- part 1: the pure functions, no database at all ---- */

function unitChecks() {
  head('בדיקה 1 — הכותרות מחליטות איזה קובץ זה');
  {
    const rowsOf = (buf) => {
      const wb = XLSX.read(buf, { type: 'buffer' });
      return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null, raw: false });
    };
    const contractsRow = rowsOf(contractsFile())[0];
    const registrationsRow = rowsOf(registrationsFile())[0];

    eq(detectExportType(contractsRow), 'contracts', '1a ייצוא החוזים מזוהה');
    eq(detectExportType(registrationsRow), 'registrations', '1b ייצוא הנרשמים מזוהה');
    // Two of the three contract columns, but no id column — not identifiable,
    // and must not be guessed at.
    eq(detectExportType({ 'מעון': '', 'דרגה': '' }), null, '1c גיליון שאינו אף אחד מהשניים — null');
    eq(detectExportType([]), null, '1d גיליון ריק — null');
    // The name is not evidence: the same header would be read the same way
    // whatever the file on disk is called.
    eq(detectExportType(CONTRACTS_HEADER), 'contracts', '1e הזיהוי הוא לפי הכותרות, גם כרשימה');
  }

  head('בדיקה 2 — פירוק שורת חוזה');
  {
    const wb = XLSX.read(contractsFile(), { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null, raw: false });
    const parsed = parseContractsRow(rows[0], { sourceFile: 'contracts_export_991.xlsx' });

    eq(parsed.child.full_name, 'אור אבוחצירא', '2a שם מלא');
    eq(parsed.child.id_number, '241111117', '2b ת"ז — ספרות בלבד');
    eq(parsed.child.id_type, 'ת.ז.', '2c סוג מספר הזהות נשמר');
    // The whole point of the serial handling: 45677 is a date, not a number.
    eq(parsed.child.birth_date?.toISOString().slice(0, 10), '2025-01-20',
      '2d תאריך לידה — סריאל אקסל הומר לתאריך');
    eq(parsed.contract.start_date?.toISOString().slice(0, 10), '2026-09-01', '2e תחילת חוזה');
    eq(parsed.contract.end_date?.toISOString().slice(0, 10), '2027-08-31', '2f סיום חוזה');
    eq(parsed.contract.class_name, 'בוגרים א', '2g הכיתה');
    // 0 is a REAL tier. A numeric coercion of a blank cell would give every
    // child in the file this same value, which is why it is kept as a string.
    eq(parsed.contract.tier, '0', '2h דרגה 0 נשמרת ואינה נעלמת');
    eq(parsed.contract.status, 'התקבל', '2i הסטטוס');
    eq(parsed.contract.tuition_type, 'מימון משרד הכלכלה', '2j שכר לימוד הוא סוג מימון, לא סכום');
    eq(parsed.contract.institution, 'הרצליה', '2k מעון — נשמר כעובדה, ואינו הסניף');
    eq(parsed.academic_year, '2026-2027', '2l שנת הלימודים תורגמה');
    ok(parsed.computed.age_group === 'פעוט' || parsed.computed.age_group === 'בוגר',
      '2m שכבת גיל חושבה', `age_group=${parsed.computed.age_group} months=${parsed.computed.age_months}`);
    ok(!('parent1' in parsed), '2n אין הורים בשורת חוזה — ואין המצאה של שדות ריקים');
  }

  head('בדיקה 3 — דרכון אינו ת"ז');
  {
    const wb = XLSX.read(
      sheetBuffer(CONTRACTS_HEADER, [contractRow({
        ...KIDS[0], idNumber: 'X12-345A', idType: 'דרכון',
      })], 'Worksheet 1'),
      { type: 'buffer' },
    );
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null, raw: false });
    const parsed = parseContractsRow(rows[0]);
    // Stripping the letters would collapse two different passports onto the
    // same digits, and merge two children into one row.
    eq(parsed.child.id_number, 'X12-345A', '3a מספר דרכון נשמר כמו שהוא');
  }

  head('בדיקה 4 — parseDate');
  {
    eq(parseDate('01/09/2026')?.toISOString().slice(0, 10), '2026-09-01', '4a DD/MM/YYYY');
    eq(parseDate(String(excelSerial(2026, 9, 1)))?.toISOString().slice(0, 10), '2026-09-01',
      '4b סריאל אקסל');
    // The real value out of `תאריך יצירה` — a serial with the time of day on
    // it. The fraction must not push it onto the wrong day.
    eq(parseDate('46196.38')?.toISOString().slice(0, 10), '2026-06-23', '4c סריאל עם שעה');
    eq(parseDate(''), null, '4d ריק');
    // Without the guard this read as the year 1234.
    eq(parseDate('1234'), null, '4e מספר שאינו סריאל סביר אינו תאריך');
    // שנה דו-ספרתית — קליקטאק כותבת אותה כשמישהו הקליד את התא ביד. `new Date`
    // קרא את זה בסדר האמריקאי, 9 בינואר, וילד/ה שנולד/ה בספטמבר יצא/ה ילידת
    // ינואר בלי שאף אחד ידע. עדיף בלי תאריך מאשר עם תאריך שגוי.
    eq(parseDate('01/09/26'), null, '4f שנה דו-ספרתית אינה נקראת — ולא בסדר האמריקאי');
    eq(parseDate('2026-09-01')?.toISOString().slice(0, 10), '2026-09-01', '4g ISO עדיין נקרא');

    head('בדיקה 4ב — מפתח הזהות: דרכון אינו ספרות');
    // שני דרכונים שונים לחלוטין שמצטמצמים לאותן שש ספרות. זה מה שקרה כשהמפתח
    // היה replace(/\D/g,''): הילד השני נבלע בשורה של הראשון.
    ok(idKey({ id_number: 'AB123456', id_type: 'דרכון' })
      !== idKey({ id_number: 'CD123456', id_type: 'דרכון' }),
      '4h שני דרכונים שונים הם שני מפתחות שונים');
    eq(idKey({ id_number: 'ab123456' }), 'AB123456', '4i אותיות — נשמר כמו שהוא, באותיות גדולות');
    eq(idKey({ id_number: '241-111-117' }), '241111117', '4j ת"ז — ספרות בלבד, כדי ששני הקבצים ייפגשו');
    eq(idKey({ id_number: '' }), '', '4k ריק נשאר ריק');
  }
}

/* ---- part 2: end to end, against the real server ---- */

async function main() {
  console.log('=== קליקטאק — שני הייצואים דרך כפתור אחד ===');

  unitChecks();

  mongod = await MongoMemoryServer.create({ instance: { dbName: 'gan_clicktac_contracts' } });
  PORT = await freePort();

  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_SECRET = 'clicktac-contracts-secret';
  process.env.PARENT_SECRET = 'clicktac-contracts-parent-secret';
  process.env.DISABLE_JOBS = '1';
  process.env.PORT = String(PORT);
  process.env.FRONTEND_URL = 'http://localhost:4173';
  process.env.NODE_ENV = 'development';
  process.env.GC_REEXEC = '1';
  delete process.env.PLATFORM_MONGODB_URI;

  const express = require('express');
  const originalListen = express.application.listen;
  express.application.listen = function patched(...args) {
    server = originalListen.apply(this, args);
    return server;
  };
  require('../src/index.js');
  await waitForServer();
  express.application.listen = originalListen;

  const host = String(mongoose.connection.host || '');
  if (!/^(127\.0\.0\.1|localhost|::1)$/.test(host)) {
    throw new Error(`מסד הנתונים אינו מקומי (${host}) — עוצרים`);
  }
  console.log(`\nשרת עלה על :${PORT}, מסד נתונים בזיכרון (${host})`);

  const { User, Branch, ExternalEnrollment, EnrollmentImport } = require('../src/models');
  const branch = await Branch.create({ name: 'הרצליה', address: 'סוקולוב 1' });
  // הסניף השני קיים כדי שאפשר יהיה להעלות קובץ מול הסניף הלא נכון — הטעות
  // שהמערכת הייתה בולעת בשקט. שני סניפי כפר סבא הם המקרה האמיתי.
  const otherBranch = await Branch.create({ name: 'כפר סבא ב', address: 'ויצמן 2' });
  await User.create({
    email: 'admin@ct.local', full_name: 'אורי מנהל', id_number: '900000001',
    role: 'system_admin', branch_id: branch._id, position: 'מנהל מערכת',
    password_hash: await bcrypt.hash(PASSWORD, 10), password_set: true, is_active: true,
  });
  const login = await request({
    method: 'POST', path: '/api/auth/login-password',
    body: { full_name: 'אורי מנהל', id_number: '900000001', password: PASSWORD },
  });
  const token = login.body?.token;
  if (!token) throw new Error(`התחברות נכשלה: ${login.status} ${login.text}`);

  /**
   * THE UNIQUE INDEX HAS TO ACTUALLY EXIST HERE.
   *
   * `(source, academic_year, child.id_number)` is declared on the schema and is
   * long since built in production, but in this harness mongoose's background
   * index build does not finish against the ephemeral mongod — the collection
   * came up with `_id_` and nothing else, and the collision this file is about
   * simply could not happen. Building it explicitly is what makes בדיקה 12 a
   * test of the server rather than of the fixture.
   */
  await ExternalEnrollment.syncIndexes();
  const indexesAfterSync = await ExternalEnrollment.collection.indexes();
  ok(indexesAfterSync.some(i => i.unique),
    '0a האינדקס הייחודי קיים — אחרת בדיקה 12 חסרת משמעות');
  ok(indexesAfterSync.some(i => i.unique
    && JSON.stringify(i.key) === JSON.stringify({ source: 1, academic_year: 1, 'child.id_number': 1 })),
    '0b צורת האינדקס הייחודי היא source+academic_year+child.id_number');

  const branchId = String(branch._id);
  const importContracts = () => upload({
    token, path: '/api/external-enrollments/import',
    fileName: 'contracts_export_1739.xlsx', buffer: contractsFile(),
    fields: { branch_id: branchId, academic_year: YEAR },
  });
  const importRegistrations = () => upload({
    token, path: '/api/external-enrollments/import',
    fileName: 'Registrations Export.xlsx', buffer: registrationsFile(),
    fields: { branch_id: branchId, academic_year: YEAR },
  });
  const listRows = async () => {
    const r = await request({ token, path: `/api/external-enrollments?year=${encodeURIComponent(YEAR)}` });
    return r.body;
  };
  const wipe = async () => {
    await ExternalEnrollment.deleteMany({});
    await EnrollmentImport.deleteMany({});
  };

  /* ------------------------------------------------------------ *
   * (a) contracts first
   * ------------------------------------------------------------ */
  head('בדיקה 5 — קליטת קובץ חוזים בלבד');
  let firstRowId = null;
  {
    const res = await importContracts();
    ok(res.status === 200, '5a הקובץ נקלט', `${res.status} ${res.text?.slice(0, 200)}`);
    eq(res.body?.export_type, 'contracts', '5b המערכת זיהתה שזה ייצוא החוזים');
    eq(res.body?.created, 3, '5c נוצרו 3 שורות');

    const data = await listRows();
    eq(data?.enrollments?.length, 3, '5d ובטבלה יש 3 שורות');
    const row = data.enrollments.find(e => e.child.full_name === 'אור אבוחצירא');
    firstRowId = row?.id;
    eq(row?.sources, ['contracts'], '5e המקור הוא ייצוא החוזים בלבד');
    eq(row?.missing_parents, true, '5f והשורה מסומנת כחסרת פרטי הורים');
    eq(row?.parent1?.first_name, '', '5g אין הורה — ולא הומצא אחד');
    eq(row?.contract?.class_name, 'בוגרים א', '5h הכיתה נשמרה');
    eq(row?.contract?.tier, '0', '5i והדרגה');
    // שלושת השדות שרק הקובץ הזה מביא.
    eq(row?.child?.nickname, 'אורי', '5q הכינוי נשמר');
    eq(row?.child?.id_type, 'ת.ז.', '5r סוג מספר הזהות נשמר');
    eq(row?.child?.medical_notes, 'אלרגיה לבוטנים', '5s וההערה הרפואית');
    eq(data?.summary?.missing_parents, 3, '5j המונה סופר את שלושתם');
    eq(data?.summary?.with_contract, 3, '5k ולשלושתם יש חוזה');

    // בייצוא החוזים אין עמודת תשלום בכלל. לסמן את השורות האלה כ"לא הוגדר
    // אמצעי תשלום" זה לשלוח את המשרד להתקשר למשפחה על קובץ שאיש עוד לא העלה —
    // והמסך כבר אומר עליהן את הדבר הנכון, "חסר פרטי הורים".
    eq(row?.payment_alert, null, '5o שורת חוזים אינה מסומנת כחסרת אמצעי תשלום');
    eq(data?.summary?.payment_alerts, 0, '5p ואין ולו התרעת תשלום אחת');

    // The card the office reads: contracts in, registrations still missing.
    ok(!!data?.last_import?.contracts, '5l "קובץ אחרון" יודע על קליטת החוזים');
    eq(data?.last_import?.contracts?.export_type, 'contracts', '5m ומסומן כייצוא חוזים');
    eq(data?.last_import?.registrations, null, '5n וייצוא הנרשמים — טרם הועלה');
  }

  head('בדיקה 6 — שורה בלי הורים אינה נקלטת למערכת');
  {
    const res = await request({
      method: 'POST', token, path: `/api/external-enrollments/${firstRowId}/promote`,
      body: { monthly_fee: 1500 },
    });
    eq(res.status, 400, '6a הקליטה נדחית');
    eq(res.body?.code, 'MISSING_PARENTS', '6b עם קוד שאפשר לתפוס');
    ok(/ייצוא הנרשמים/.test(res.body?.error || ''),
      '6c וההודעה אומרת איזה קובץ חסר', res.body?.error);

    const bulk = await request({
      method: 'POST', token, path: '/api/external-enrollments/promote-bulk',
      body: { ids: [firstRowId], fees_by_age_group: { 'פעוט': 1500, 'בוגר': 1500 } },
    });
    eq(bulk.body?.imported, 0, '6d גם בקליטה מרובה — אף אחד לא נקלט');
    eq(bulk.body?.skipped?.[0]?.code, 'MISSING_PARENTS', '6e ואותה סיבה מדווחת פר שורה');
  }

  head('בדיקה 7 — ואז ייצוא הנרשמים, לאותם ילדים');
  {
    const res = await importRegistrations();
    ok(res.status === 200, '7a הקובץ נקלט', `${res.status} ${res.text?.slice(0, 200)}`);
    eq(res.body?.export_type, 'registrations', '7b זוהה כייצוא הנרשמים');
    // The three already exist — they must be FILLED, not duplicated.
    eq(res.body?.created, 1, '7c נוצרה שורה אחת בלבד (הילד/ה הרביעי/ת)');
    eq(res.body?.updated, 3, '7d ושלוש שורות מוזגו');
    eq(res.body?.missing, 0, '7e ואף אחד לא סומן כמי שירד מהקובץ');

    const data = await listRows();
    eq(data?.enrollments?.length, 4, '7f סה"כ 4 שורות — בלי כפילויות');
    const row = data.enrollments.find(e => e.child.full_name === 'אור אבוחצירא');
    eq(row?.id, firstRowId, '7g וזו אותה שורה שנוצרה מהחוזים');
    eq(row?.sources, ['contracts', 'registrations'], '7h שני המקורות רשומים בה');
    eq(row?.missing_parents, false, '7i היא כבר לא חסרת הורים');
    eq(row?.parent1?.phone, '050000001', '7j הטלפון נקלט');
    eq(row?.contract?.class_name, 'בוגרים א', '7k והחוזה לא נדרס');
    eq(row?.contract?.tier, '0', '7l הדרגה שרדה את הקליטה השנייה');
    /* ---- ומה שרק ייצוא החוזים ידע עליו לא נמחק ---- *
     * המיזוג של ייצוא הנרשמים הוא Object.assign שמחליף את כל ענף `child`
     * בבת אחת, ולפרסר של הנרשמים אין בכלל את שלושת השדות האלה. עד התיקון הם
     * נמחקו כאן בשקט — ושום העלאה חוזרת לא החזירה אותם, כי ה-hash של קובץ
     * החוזים לא זז ולכן הקליטה החוזרת נקראה "ללא שינוי". medical_notes היא
     * רשימת אלרגיות. */
    eq(row?.child?.nickname, 'אורי', '7x הכינוי שרד את קליטת הנרשמים');
    eq(row?.child?.id_type, 'ת.ז.', '7y וסוג מספר הזהות');
    eq(row?.child?.medical_notes, 'אלרגיה לבוטנים', '7z וההערה הרפואית — אלרגיה אינה נמחקת');
    eq(data?.summary?.missing_parents, 0, '7m המונה התאפס');
    ok(!!data?.last_import?.registrations && !!data?.last_import?.contracts,
      '7n "קובץ אחרון" מציג שני תאריכים');

    /* ---- אמצעי התשלום, ברגע שייצוא הנרשמים הגיע ---- */
    const byName = (n) => data.enrollments.find(e => e.child.full_name === n);
    eq(byName('אור אבוחצירא')?.payment_alert, null, '7o כרטיס אשראי — אין התרעה');
    eq(byName('נועם כהן')?.payment_alert?.code, 'cash', '7p מזומן מסומן');
    eq(byName('נועם כהן')?.payment_alert?.label, 'מזומן — לא מתקבל', '7q עם התווית לעובדת המשרד');
    eq(byName('שירה לוי')?.payment_alert?.code, 'missing', '7r ושורה בלי אמצעי תשלום כלל');
    // הו"ק היא אמצעי שהגן מקבל — מה שחסר הוא פרטי הבנק, וזאת שיחת טלפון
    // אחרת. הבדיקה הזאת עוברת רק אם list באמת קורא את standing_order.
    eq(byName('איתי מזרחי')?.payment_alert?.code, 'incomplete', '7s והו"ק בלי פרטי בנק');
    eq(data?.summary?.payment_alerts, 3, '7t המונה סופר את שלוש ההתרעות');

    // ...ופרטי הבנק עצמם עדיין אינם חוצים את החוט. זה מה שאפשר את החישוב, ואם
    // מישהו יסיר את הסינון בעתיד — כאן זה ייתפס.
    ok(data.enrollments.every(e => e.standing_order === undefined),
      '7u ופרטי הבנק אינם מוחזרים בטבלה');

    // מה שקליקטאק באמת כותבת, כפי שהוא — כדי שהמשרד יראה מתי התוויות משתנות.
    const methods = data?.payment_methods || [];
    eq(methods.find(m => m.value === 'כרטיס אשראי')?.count, 1, '7v ספירת הערכים הגולמיים');
    eq(methods.find(m => m.value === '')?.count, 1, '7w והריק נספר גם הוא');
  }

  head('בדיקה 8 — ועכשיו אפשר לקלוט');
  {
    const res = await request({
      method: 'POST', token, path: `/api/external-enrollments/${firstRowId}/promote`,
      body: { monthly_fee: 1500 },
    });
    ok(res.status === 201, '8a הקליטה מצליחה', `${res.status} ${res.text?.slice(0, 200)}`);
    const src = res.body?.registration?.configuration?.external_source;
    eq(src?.contract_tier, '0', '8b והדרגה נרשמת על הרישום — מספר שאפשר להסביר בדיעבד');
    eq(src?.contract_class, 'בוגרים א', '8c יחד עם הכיתה מהחוזה');
  }

  /* ------------------------------------------------------------ *
   * (c) the reverse order
   * ------------------------------------------------------------ */
  head('בדיקה 9 — הסדר ההפוך: נרשמים ואז חוזים');
  {
    await wipe();
    const first = await importRegistrations();
    eq(first.body?.created, 4, '9a ייצוא הנרשמים יצר 4 שורות');

    const second = await importContracts();
    ok(second.status === 200, '9b וייצוא החוזים נקלט אחריו', `${second.status} ${second.text?.slice(0, 200)}`);
    eq(second.body?.created, 0, '9c בלי ליצור ולו שורה אחת חדשה');
    eq(second.body?.updated, 3, '9d ושלוש שורות קיבלו את החוזה');

    const data = await listRows();
    eq(data?.enrollments?.length, 4, '9e עדיין 4 שורות — אותו מספר כמו בסדר ההפוך');
    const row = data.enrollments.find(e => e.child.full_name === 'נועם כהן');
    eq(row?.sources, ['registrations', 'contracts'], '9f שני המקורות');
    eq(row?.contract?.tier, '7', '9g הדרגה מהחוזה');
    eq(row?.parent1?.phone, '050000002', '9h וההורה מהנרשמים');
    // The one child the contracts file never mentioned.
    const extra = data.enrollments.find(e => e.child.full_name === 'איתי מזרחי');
    eq(extra?.sources, ['registrations'], '9i ילד/ה שאינו/ה בקובץ החוזים נשאר/ת עם מקור אחד');
    eq(extra?.contract, null, '9j ובלי חוזה');
    eq(data?.summary?.missing_parents, 0, '9k ואף אחד אינו חסר הורים');
  }

  head('בדיקה 10 — קליטה חוזרת של אותו קובץ חוזים אינה משנה דבר');
  {
    const before = await listRows();
    const res = await importContracts();
    eq(res.body?.created, 0, '10a לא נוצר כלום');
    eq(res.body?.updated, 0, '10b ולא עודכן כלום');
    eq(res.body?.unchanged, 3, '10c שלוש השורות זוהו כלא-משתנות');

    const after = await listRows();
    eq(after?.enrollments?.length, before?.enrollments?.length, '10d מספר השורות לא זז');
    const changed = after.enrollments.filter(e => (e.changes || []).length
      !== (before.enrollments.find(b => b.id === e.id)?.changes || []).length);
    eq(changed.length, 0, '10e ולא נרשמו שינויים חדשים באף שורה');
  }

  /* ------------------------------------------------------------ *
   * (e) the three ways a row does NOT get written
   * ------------------------------------------------------------ */
  head('בדיקה 11 — שני דרכונים שונים הם שני ילדים');
  {
    await wipe();
    // ספרות זהות, אותיות שונות. עד התיקון המפתח היה הספרות בלבד, ולכן השני
    // התמזג לתוך השורה של הראשון וקיבל את הכיתה והדרגה שלו.
    const twoPassports = sheetBuffer(CONTRACTS_HEADER, [
      contractRow({
        id: '400001', first: 'ליאם', last: 'סמית', idNumber: 'AB123456', idType: 'דרכון',
        birth: [2025, 4, 4], cls: 'בוגרים א', tier: 3,
      }),
      contractRow({
        id: '400002', first: 'אמה', last: 'ג׳ונס', idNumber: 'CD123456', idType: 'דרכון',
        birth: [2025, 6, 9], cls: 'בוגרים ב', tier: 9,
      }),
    ], 'Worksheet 1');
    const res = await upload({
      token, path: '/api/external-enrollments/import',
      fileName: 'contracts_passports.xlsx', buffer: twoPassports,
      fields: { branch_id: branchId, academic_year: YEAR },
    });
    ok(res.status === 200, '11a הקובץ נקלט', `${res.status} ${res.text?.slice(0, 200)}`);
    eq(res.body?.created, 2, '11b נוצרו שתי שורות — ולא אחת');

    const data = await listRows();
    eq(data?.enrollments?.length, 2, '11c ובטבלה שני ילדים');
    const liam = data.enrollments.find(e => e.child.full_name === 'ליאם סמית');
    const emma = data.enrollments.find(e => e.child.full_name === 'אמה ג׳ונס');
    eq(liam?.contract?.tier, '3', '11d הדרגה של הראשון');
    eq(emma?.contract?.tier, '9', '11e והדרגה של השנייה — לא נדרסה');
  }

  head('בדיקה 12 — שתי שורות בלי ת"ז אינן מפילות את הקליטה');
  {
    await wipe();
    // האינדקס הייחודי הוא (source, academic_year, child.id_number) והוא
    // מאנדקס גם את המחרוזת הריקה. השורה השנייה התנגשה בראשונה וזרקה E11000
    // מאמצע הלולאה: 500, חצי קובץ כתוב, ואף אחד לא ידע איזה חצי.
    const blankIds = sheetBuffer(CONTRACTS_HEADER, [
      contractRow({
        id: '400010', first: 'יובל', last: 'ברק', idNumber: '', birth: [2025, 2, 2],
        cls: 'בוגרים א', tier: 1,
      }),
      contractRow({
        id: '400011', first: 'רוני', last: 'שגב', idNumber: '', birth: [2025, 7, 7],
        cls: 'בוגרים ב', tier: 2,
      }),
    ], 'Worksheet 1');
    const res = await upload({
      token, path: '/api/external-enrollments/import',
      fileName: 'contracts_blank_ids.xlsx', buffer: blankIds,
      fields: { branch_id: branchId, academic_year: YEAR },
    });
    eq(res.status, 200, '12a הקליטה מסתיימת בהצלחה ולא ב-500');
    eq(res.body?.created, 1, '12b שורה אחת נכתבה');
    eq(res.body?.skipped_duplicate, 1, '12c והשנייה נספרה כדילוג');
    eq(res.body?.skipped_names, ['רוני שגב'], '12d בשמה, כדי שאפשר יהיה לתקן בקליקטאק');
    ok(/ת"ז/.test(res.body?.skipped_label || ''), '12e והסיבה כתובה', res.body?.skipped_label);

    const data = await listRows();
    eq(data?.enrollments?.length, 1, '12f ובמסד יש שורה אחת — לא אפס ולא שגיאה');
  }

  head('בדיקה 13 — קובץ חוזים מול הסניף הלא נכון אינו נבלע');
  {
    await wipe();
    const first = await importContracts();
    eq(first.body?.created, 3, '13a שלושת הילדים נקלטו בהרצליה');
    const before = await listRows();
    const beforeRow = before.enrollments.find(e => e.child.full_name === 'אור אבוחצירא');

    const wrong = await upload({
      token, path: '/api/external-enrollments/import',
      fileName: 'contracts_export_1739.xlsx', buffer: contractsFile(),
      fields: { branch_id: String(otherBranch._id), academic_year: YEAR },
    });
    eq(wrong.status, 200, '13b ההעלאה מוחזרת עם תשובה, לא עם שגיאה');
    eq(wrong.body?.created, 0, '13c ולא נוצרה ולו שורה אחת בסניף השני');
    eq(wrong.body?.updated, 0, '13d ולא עודכן דבר');
    eq(wrong.body?.cross_branch, 3, '13e שלוש השורות נספרו כשייכות לסניף אחר');
    eq(wrong.body?.cross_branch_names?.length, 3, '13f ודווחו בשמן');
    ok(/סניף אחר/.test(wrong.body?.cross_branch_label || ''),
      '13g עם המשפט שאומר מה קרה', wrong.body?.cross_branch_label);

    const after = await listRows();
    eq(after?.enrollments?.length, 3, '13h מספר השורות לא זז');
    const afterRow = after.enrollments.find(e => e.child.full_name === 'אור אבוחצירא');
    eq(String(afterRow?.branch_id), String(beforeRow?.branch_id), '13i והשורה נשארה בסניף שלה');
    eq((afterRow?.changes || []).length, (beforeRow?.changes || []).length,
      '13j ולא נרשם עליה שום שינוי');
  }

  head('בדיקה 14 — שורת נרשמים בלי שם הורה עדיין נקלטת');
  {
    await wipe();
    // ייצוא הנרשמים כן מכיל שורות שעמודות ההורה בהן ריקות — משפחה שהוקלדה
    // ביד, מחזור ישן. השורות האלה היו ניתנות לקליטה לפני שייצוא החוזים היה
    // קיים, והן צריכות להישאר כאלה: החסימה קיימת בשביל שורת חוזים בלבד, שאין
    // בה עמודת הורה בכלל. אחרת המסך שולח את המשרד להעלות קובץ שכבר הועלה.
    const noParent = sheetBuffer(
      REGISTRATIONS_HEADER,
      [registrationRow({
        first: 'תמר', last: 'פרץ', idNumber: '245555558', birth: [2025, 5, 5],
        parentFirst: '', parentPhone: '',
      })],
      'Sheet1',
    );
    const res = await upload({
      token, path: '/api/external-enrollments/import',
      fileName: 'Registrations Export.xlsx', buffer: noParent,
      fields: { branch_id: branchId, academic_year: YEAR },
    });
    eq(res.body?.created, 1, '14a השורה נקלטה');

    const data = await listRows();
    const row = data.enrollments.find(e => e.child.full_name === 'תמר פרץ');
    eq(row?.parent1?.first_name, '', '14b ואכן אין בה שם הורה');
    eq(row?.missing_parents, false, '14c ובכל זאת היא אינה מסומנת כחסרת פרטי הורים');
    eq(data?.summary?.missing_parents, 0, '14d והמונה אינו סופר אותה');

    const promote = await request({
      method: 'POST', token, path: `/api/external-enrollments/${row?.id}/promote`,
      body: { monthly_fee: 1500 },
    });
    ok(promote.status === 201, '14e והקליטה למערכת מצליחה',
      `${promote.status} ${promote.text?.slice(0, 200)}`);
  }

  head('בדיקה 15 — תאריך לידה לא קריא בייצוא הנרשמים אינו מוחק שכבת גיל שכבר חושבה');
  {
    // אור אבוחצירא שוב, אבל בקובץ נרשמים משלה שבו תא תאריך הלידה ריק — בדיוק
    // כמו תא שנכתב ביד ולא נקרא. keepFilledChildFields כבר שומר על
    // child.birth_date במקרה הזה; הבדיקה הזאת היא על computed, ש-Object.assign
    // דורס בשלמותו (ר' ההערה מעל השורה 454) ולפני התיקון היה יוצא null.
    await wipe();
    const kid = {
      id: '337301', first: 'דניאל', last: 'פרץ', idNumber: '245555559', birth: [2025, 2, 10],
      cls: 'בוגרים א', tier: 3,
    };
    const contracts = sheetBuffer(CONTRACTS_HEADER, [contractRow(kid)], 'Worksheet 1');
    const c1 = await upload({
      token, path: '/api/external-enrollments/import',
      fileName: 'contracts_export_one.xlsx', buffer: contracts,
      fields: { branch_id: branchId, academic_year: YEAR },
    });
    eq(c1.body?.created, 1, '15a שורת החוזה נוצרה');

    const before = await listRows();
    const beforeRow = before.enrollments.find(e => e.child.full_name === 'דניאל פרץ');
    ok(!!beforeRow?.computed?.age_group, '15b שכבת הגיל חושבה מהחוזה', beforeRow?.computed?.age_group);

    const regRow = registrationRow({ ...kid, parentFirst: 'הורה15', parentPhone: '0500000015' });
    const birthIdx = REGISTRATIONS_HEADER.indexOf(COLUMNS.birth_date);
    regRow[birthIdx] = ''; // התא הלא קריא
    const registrations = sheetBuffer(REGISTRATIONS_HEADER, [regRow], 'Sheet1');
    const r1 = await upload({
      token, path: '/api/external-enrollments/import',
      fileName: 'registrations_export_one.xlsx', buffer: registrations,
      fields: { branch_id: branchId, academic_year: YEAR },
    });
    eq(r1.body?.updated, 1, '15c שורת הנרשמים מוזגה לאותה שורה');

    const after = await listRows();
    const afterRow = after.enrollments.find(e => e.child.full_name === 'דניאל פרץ');
    eq(afterRow?.child?.birth_date, beforeRow?.child?.birth_date,
      '15d תאריך הלידה של הילד נשאר (keepFilledChildFields)');
    eq(afterRow?.computed?.age_group, beforeRow?.computed?.age_group,
      '15e שכבת הגיל המחושבת לא נמחקה');
    eq(afterRow?.computed?.age_months, beforeRow?.computed?.age_months,
      '15f וגם חודשי הגיל נשארו');
  }

  head('בדיקה 16 — אותו שם ואותו תאריך לידה, ת"ז שונה — שני ילדים');
  {
    await wipe();
    /**
     * THE CASE THIS PREVENTS. שני אחים על שם אותה סבתא, או תאומים — אותו שם
     * משפחה, אותו תאריך לידה, ות"ז שונה. כלל המיזוג השני (שם + תאריך לידה)
     * קיים כי רוב הילדים במערכת בלי ת"ז שמורה בכלל, אבל בלי אימות מול הת"ז
     * הוא היה מוזג את השני לתוך הראשון — והשני היה מקבל את הכיתה, הדרגה
     * והחוזה של הראשון, ושורה אחת פשוט נעלמת בלי שאף אחד יידע.
     */
    const twins = sheetBuffer(CONTRACTS_HEADER, [
      contractRow({
        id: '400020', first: 'מעיין', last: 'דהן', idNumber: '246666664',
        birth: [2025, 3, 12], cls: 'בוגרים א', tier: 4,
      }),
      contractRow({
        id: '400021', first: 'מעיין', last: 'דהן', idNumber: '247777772',
        birth: [2025, 3, 12], cls: 'בוגרים ב', tier: 9,
      }),
    ], 'Worksheet 1');
    const res = await upload({
      token, path: '/api/external-enrollments/import',
      fileName: 'contracts_twins.xlsx', buffer: twins,
      fields: { branch_id: branchId, academic_year: YEAR },
    });
    eq(res.status, 200, '16a הקובץ נקלט');
    eq(res.body?.created, 2, '16b ונוצרו שתי שורות — לא אחת');

    const data = await listRows();
    eq(data?.enrollments?.length, 2, '16c ובטבלה שני ילדים');
    const tiers = data.enrollments.map(e => e.contract?.tier).sort();
    eq(tiers, ['4', '9'], '16d ולכל אחד/ת הדרגה של עצמו/ה — אף אחת לא נדרסה');
  }

  head('בדיקה 17 — אותו שם ותאריך לידה, ת"ז רק בצד אחד — אותו ילד');
  {
    await wipe();
    // המקרה שבשבילו הכלל השני נכתב מלכתחילה: ייצוא החוזים כותב דרכון או
    // משאיר את התא ריק, וייצוא הנרשמים מחזיק ת"ז. צד אחד שותק, ולכן אין
    // סתירה — וזה אותו ילד, שאסור שיופיע פעמיים.
    const blankIdContract = sheetBuffer(CONTRACTS_HEADER, [
      contractRow({
        id: '400030', first: 'יהלי', last: 'אזולאי', idNumber: '',
        birth: [2025, 4, 18], cls: 'בוגרים א', tier: 5,
      }),
    ], 'Worksheet 1');
    const c = await upload({
      token, path: '/api/external-enrollments/import',
      fileName: 'contracts_blank_one.xlsx', buffer: blankIdContract,
      fields: { branch_id: branchId, academic_year: YEAR },
    });
    eq(c.body?.created, 1, '17a שורת החוזה נוצרה בלי ת"ז');

    const withId = sheetBuffer(REGISTRATIONS_HEADER, [registrationRow({
      first: 'יהלי', last: 'אזולאי', idNumber: '248888880', birth: [2025, 4, 18],
      parentFirst: 'הורה17', parentPhone: '0500000017',
    })], 'Sheet1');
    const r = await upload({
      token, path: '/api/external-enrollments/import',
      fileName: 'Registrations Export.xlsx', buffer: withId,
      fields: { branch_id: branchId, academic_year: YEAR },
    });
    eq(r.body?.created, 0, '17b ולא נוצרה שורה שנייה');
    eq(r.body?.updated, 1, '17c אלא אותה שורה מולאה');

    const data = await listRows();
    eq(data?.enrollments?.length, 1, '17d ובטבלה ילד/ה אחד/ת');
    const row = data.enrollments[0];
    eq(row?.contract?.tier, '5', '17e הדרגה מהחוזה');
    eq(row?.child?.id_number, '248888880', '17f והת"ז מהנרשמים');
  }

  head('בדיקה 18 — הדרגה מייצור החוזים קובעת את שכר הלימוד');
  {
    /**
     * THE STORY. שכר הלימוד במעון מסובסד הוא תא במטריצה של המדינה: דרגת
     * הסבסוד של המשפחה כפול שכבת הגיל של הילד/ה. הדרגה לא הייתה באף קובץ, ולכן
     * המסך ביקש דרגה אחת והחיל אותה על מחזור שלם — שגוי לכל משפחה שהכנסתה שונה
     * מזו שהוקלדה. ייצוא החוזים מביא את הדרגה לכל ילד/ה בנפרד, ומכאן השרת הוא
     * שמתמחר, ולא המסך.
     *
     * המטריצה: שלוש שכבות גיל × שלוש דרגות. הילדים כאן כולם פעוטות ב-1.9
     * (עמודה 1), ולכן דרגה 2 היא 2,100 ₪.
     */
    const { BranchPricing } = require('../src/models');
    const MATRIX = {
      age_groups: ['תינוק', 'פעוט', 'בוגר'],
      tiers: [
        { label: 'דרגה 1', prices: [1000, 1100, 1200] },
        { label: 'דרגה 2', prices: [2000, 2100, 2200] },
        { label: 'דרגה 3', prices: [3000, 3100, 3200] },
      ],
    };
    const setPricing = (patch) => BranchPricing.findOneAndUpdate(
      { branch_id: branch._id, academic_year: YEAR },
      // YEAR is written with an ASCII double quote — exactly the spelling the
      // pricing editor saves — while hebrewYearForStart produces a gershayim.
      // That the lookup finds this document at all is half of what 18 tests.
      { $set: { branch_id: branch._id, academic_year: YEAR, ...patch } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    /**
     * One child, both files, promoted — and the registration that came out.
     *
     * A FRESH ת"ז EVERY TIME. `wipe()` clears the ClickTac queue and not the
     * Registrations it produced, so reusing one id would make the second run
     * match the first run's registration and be refused as a duplicate — which
     * is correct behaviour and useless as a fixture.
     */
    let tierCase = 0;
    const promoteWithTier = async (tier, body = {}) => {
      await wipe();
      tierCase += 1;
      const kid = {
        id: `4001${tier}${tierCase}`, first: 'רותם', last: `בר${tierCase}`,
        idNumber: `24999000${tierCase}`,
        birth: [2025, 3, 3], cls: 'בוגרים א', tier,
      };
      await upload({
        token, path: '/api/external-enrollments/import',
        fileName: 'contracts_tier.xlsx',
        buffer: sheetBuffer(CONTRACTS_HEADER, [contractRow(kid)], 'Worksheet 1'),
        fields: { branch_id: branchId, academic_year: YEAR },
      });
      await upload({
        token, path: '/api/external-enrollments/import',
        fileName: 'Registrations Export.xlsx',
        buffer: sheetBuffer(REGISTRATIONS_HEADER, [registrationRow({
          ...kid, parentFirst: 'הורה18', parentPhone: '0500000018',
        })], 'Sheet1'),
        fields: { branch_id: branchId, academic_year: YEAR },
      });
      const data = await listRows();
      const row = data.enrollments[0];
      const res = await request({
        method: 'POST', token, path: `/api/external-enrollments/${row.id}/promote`,
        body: { monthly_fee: 1500, ...body },
      });
      return { res, reg: res.body?.registration, row };
    };

    await setPricing({ pricing_type: 'subsidized', ...MATRIX });

    // ---- the cell the tier prices ----
    {
      const { res, reg, row } = await promoteWithTier(2);
      ok(res.status === 201, '18a הקליטה מצליחה', `${res.status} ${res.text?.slice(0, 200)}`);
      eq(row?.computed?.age_group, 'פעוט', '18b הילד/ה פעוט/ה ב-1.9 — עמודה 1');
      eq(row?.fee_by_tier, 2100, '18c והמסך מראה את שכר הלימוד לפי הדרגה עוד לפני הקליטה');
      eq(reg?.monthly_fee, 2100, '18d הרישום נוצר עם התא מהמטריצה — ולא עם 1,500 שנשלחו');
      eq(reg?.fee_source, 'tier', '18e ומתועד מאיפה המספר הגיע');
      eq(reg?.fee_tier, 'דרגה 2', '18f ואיזו שורה במטריצה');
    }

    // ---- no tier: the request's fee, exactly as before ----
    {
      const { reg, row } = await promoteWithTier(0);
      eq(row?.fee_by_tier, null, '18g דרגה 0 היא "לא ידוע" — אין מה להראות');
      eq(reg?.monthly_fee, 1500, '18h ולכן נקלט עם מה שהמסך שלח');
      eq(reg?.fee_source, 'manual', '18i ומסומן ככזה');
    }

    // ---- a tier the branch does not price ----
    {
      const { reg, row } = await promoteWithTier(9);
      eq(row?.fee_by_tier, null, '18j דרגה שאינה במטריצה של הסניף אינה ממציאה מחיר');
      eq(reg?.monthly_fee, 1500, '18k והסכום נשאר של המסך');
      eq(reg?.fee_source, 'manual', '18l ומסומן ככזה');
    }

    // ---- an explicit override beats the matrix ----
    {
      const { reg } = await promoteWithTier(2, { monthly_fee_override: 1234 });
      eq(reg?.monthly_fee, 1234, '18m מי שביקש במפורש לעקוף — עוקף');
      eq(reg?.fee_source, 'override', '18n והעקיפה מתועדת');
      eq(reg?.fee_tier, 'דרגה 2', '18o ביחד עם הדרגה שנעקפה — כדי שאפשר יהיה להסביר את הפער');
    }

    // ---- a private branch has no matrix at all ----
    {
      await setPricing({ pricing_type: 'private', fixed_monthly_fee: 3000 });
      const { reg, row } = await promoteWithTier(2);
      eq(row?.fee_by_tier, null, '18p במעון פרטי אין מטריצת דרגות');
      eq(reg?.monthly_fee, 1500, '18q והסכום הוא של המסך');
      eq(reg?.fee_source, 'manual', '18r ומסומן ככזה');
    }
    await setPricing({ pricing_type: 'subsidized', ...MATRIX });
  }

  /* ================================================================== *
   * בדיקה 19 — התוויות האמיתיות של טבלת המדינה
   *
   * THE MATCH WAS INERT AGAINST THE ONLY TABLE ANYBODY USES. עורך המחירון
   * זורע את שורות משרד העבודה כלשונן — "דרגה 3 (0–2,330)" — ושמירה שומרת
   * אותן מילה במילה. כלל ההתאמה הקודם שרשר את כל הספרות שבתווית, כך ש"דרגה
   * 3 (0–2,330)" הפך ל-"302330" ולא התאים לשום דרגה. עשר מתוך שתים עשרה
   * השורות המשווקות היו בלתי נגישות, וכל התכונה הייתה no-op שקט בייצור.
   *
   * התוויות כאן מועתקות מילה במילה מ-PricingManager.jsx, ושמות העמודות הם
   * DEFAULT_AGE_GROUPS האמיתיים — לא ניסוח שהומצא לטובת הבדיקה.
   * ================================================================== */
  head('בדיקה 19 — טבלת המדינה האמיתית: כל דרגה מוצאת את השורה שלה');
  {
    const { tierFeeFor, tierIndex, ageGroupIndex } = require('../src/services/tier-fee.service');

    // ---- verbatim from client/src/components/pricing/PricingManager.jsx ----
    const DEFAULT_AGE_GROUPS = ['עד 15 חודש', '15–24 חודש', 'מעל 24 חודש'];
    const TMT_5786 = [
      { label: 'דרגה 3 (0–2,330)', prices: [1157, 938, 941] },
      { label: 'דרגה 4 (2,331–2,880)', prices: [1401, 1109, 1113] },
      { label: 'דרגה 5 (2,881–3,330)', prices: [1663, 1318, 1323] },
      { label: 'דרגה 6 (3,331–3,880)', prices: [1748, 1377, 1382] },
      { label: 'דרגה 7 (3,881–4,440)', prices: [2011, 1549, 1554] },
      { label: 'דרגה 8 (4,441–4,880)', prices: [2180, 1703, 1709] },
      { label: 'דרגה 9 (4,881–5,440)', prices: [2328, 1811, 1817] },
      { label: 'דרגה 10 (5,441–5,880)', prices: [2432, 1908, 1914] },
      { label: 'דרגה 11 (5,881–6,660)', prices: [3936, 2917, 2587] },
      { label: 'דרגה 12 (מעל 6,660)', prices: [3936, 2917, 2587] },
      { label: 'דרגה 14', prices: [1054, 835, 837] },
      { label: 'דרגה 15', prices: [952, 731, 734] },
    ];
    const state = { pricing_type: 'subsidized', age_groups: DEFAULT_AGE_GROUPS, tiers: TMT_5786 };

    // כל דרגה מוצאת את שורתה שלה — לא את זו שלפניה ולא אף אחת.
    const misrouted = TMT_5786
      .map((t, i) => ({ n: Number(t.label.match(/\d+/)[0]), want: i, got: tierIndex(t.label.match(/\d+/)[0], TMT_5786) }))
      .filter(x => x.got !== x.want);
    eq(misrouted, [], '19a כל 12 הדרגות בטבלת המדינה מוצאות את השורה שלהן');

    // הראיה שזה לא היה כך: 3 ו-4 הן שתי שורות שכנות עם מחירים שונים.
    eq(tierFeeFor({ pricing: state, tier: '3', ageGroup: 'תינוק' })?.fee, 1157,
      '19b דרגה 3, תינוק — השורה הראשונה');
    eq(tierFeeFor({ pricing: state, tier: '4', ageGroup: 'תינוק' })?.fee, 1401,
      '19c דרגה 4 אינה מתומחרת לפי שורת דרגה 3');
    eq(tierFeeFor({ pricing: state, tier: '15', ageGroup: 'בוגר' })?.fee, 734,
      '19d ודרגה 15 — האחרונה, למרות שהיא השורה ה-12');
    eq(tierFeeFor({ pricing: state, tier: '12', ageGroup: 'פעוט' })?.fee, 2917,
      '19e דרגה 12 עם טווח "מעל 6,660" בתווית');

    // 13 אינה בטבלה — והמיפוי לפי מיקום היה מתמחר אותה משורה כלשהי.
    eq(tierFeeFor({ pricing: state, tier: '13', ageGroup: 'תינוק' }), null,
      '19f דרגה 13 אינה בטבלת המדינה — ואין המצאה של מחיר');
    eq(tierFeeFor({ pricing: state, tier: '1', ageGroup: 'תינוק' }), null,
      '19g וגם דרגה 1 — הטבלה מתחילה ב-3');
    eq(tierFeeFor({ pricing: state, tier: '2', ageGroup: 'תינוק' }), null,
      '19h וגם דרגה 2, שהמיפוי לפי מיקום היה מתמחר משורת דרגה 4');

    // התוויות הנקיות שמגיעות מייבוא ה-PDF — "דרגה N" בלבד.
    {
      const clean = {
        pricing_type: 'subsidized',
        age_groups: DEFAULT_AGE_GROUPS,
        tiers: [
          { label: 'דרגה 3', prices: [1157, 938, 941] },
          { label: 'דרגה 4', prices: [1401, 1109, 1113] },
        ],
      };
      eq(tierFeeFor({ pricing: clean, tier: '4', ageGroup: 'פעוט' })?.fee, 1109,
        '19i גם התוויות הנקיות "דרגה N" עובדות');
      eq(tierFeeFor({ pricing: clean, tier: 4, ageGroup: 'פעוט' })?.fee, 1109,
        '19j והדרגה יכולה להגיע כמספר, כפי שאקסל מוסר אותה');
    }

    /* ---- עמודות: המיפוי לפי מיקום תקף רק למטריצה בת שלוש עמודות ---- */
    eq(ageGroupIndex('תינוק', DEFAULT_AGE_GROUPS), 0, '19k שלוש עמודות — תינוק היא הראשונה');
    eq(ageGroupIndex('בוגר', DEFAULT_AGE_GROUPS), 2, '19l ובוגר האחרונה');
    eq(ageGroupIndex('בוגר', ['עד 15 חודש', 'מעל 15 חודש']), -1,
      '19m מטריצה בת שתי עמודות אינה הטבלה שהכלל מכיר — ולא מנחשים עמודה');
    eq(ageGroupIndex('בוגר', ['א', 'ב', 'ג', 'ד']), -1,
      '19n וגם לא מטריצה בת ארבע');
    eq(ageGroupIndex('בוגר', ['תינוק', 'פעוט', 'בוגר', 'על-יסודי']), 2,
      '19o אבל שם שמופיע בכותרת מנצח בכל מספר עמודות');
    {
      const twoCol = {
        pricing_type: 'subsidized',
        age_groups: ['עד 15 חודש', 'מעל 15 חודש'],
        tiers: [{ label: 'דרגה 3', prices: [1157, 938] }],
      };
      eq(tierFeeFor({ pricing: twoCol, tier: '3', ageGroup: 'תינוק' }), null,
        '19p ומטריצה בת שתי עמודות אינה מתמחרת — היא שולחת לשאול אדם');
    }
  }

  {
    const { BranchPricing } = require('../src/models');
    const setPricing = (patch) => BranchPricing.findOneAndUpdate(
      { branch_id: branch._id, academic_year: YEAR },
      { $set: { branch_id: branch._id, academic_year: YEAR, ...patch } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    const MATRIX = {
      age_groups: ['תינוק', 'פעוט', 'בוגר'],
      tiers: [
        { label: 'דרגה 1', prices: [1000, 1100, 1200] },
        { label: 'דרגה 2', prices: [2000, 2100, 2200] },
        { label: 'דרגה 3', prices: [3000, 3100, 3200] },
      ],
    };
    await setPricing({ pricing_type: 'subsidized', ...MATRIX });

    /* ================================================================ *
     * בדיקה 20 — החדר קובע את השכבה, והשכבה קובעת את המחיר
     *
     * THE BOARD PROMISED A NUMBER THE CONFIRM DID NOT CHARGE. לוח השיבוץ
     * הראה את שכר הלימוד לפי שכבת הגיל שחושבה מהקבצים, אבל הרשימה הנפתחת
     * ליד כל ילד/ה מציעה כל חדר בשנה — ו-confirmPlacement מחייב לפי שכבת
     * החדר שאליו שובצו בפועל. תינוקת ששובצה לחדר בוגרים חויבה לפי עמודת
     * הבוגרים ועל המסך הופיעה עמודת התינוקות.
     *
     * מכאן השרת מוסר `fees_by_group` — אותה דרגה בשלוש השכבות — והמסך קורא
     * את התא של החדר שנבחר. כאן נבדק ששני הצדדים אומרים בדיוק אותו מספר.
     * ================================================================ */
    head('בדיקה 20 — תינוקת בחדר בוגרים מחויבת לפי עמודת הבוגרים');
    {
      const { Classroom } = require('../src/models');
      // הכיתות נשמרות בשנה המנורמלית — אותה מחרוזת שהקליטה כותבת על הרשומה,
      // ואותה מחרוזת ש-confirmPlacement מחפש לפיה.
      const { normalizeYear } = require('../src/services/academic-year.service');
      const ROOM_YEAR = normalizeYear(YEAR);
      await Classroom.deleteMany({ branch_id: branch._id });
      const [babyRoom, seniorRoom] = await Classroom.create([
        { name: 'תינוקייה א', category: 'תינוקייה', academic_year: ROOM_YEAR, branch_id: branch._id, capacity: 10 },
        { name: 'בוגרים א', category: 'בוגרים', academic_year: ROOM_YEAR, branch_id: branch._id, capacity: 20 },
      ]);
      ok(!!babyRoom && !!seniorRoom, '20a שני חדרים — תינוקייה ובוגרים');

      await wipe();
      // נולדה במרץ 2026 — בת חצי שנה ב-1 בספטמבר, כלומר תינוקת מובהקת.
      const baby = {
        id: '5001', first: 'שירה', last: 'תינוקת', idNumber: '249880001',
        birth: [2026, 3, 1], cls: 'תינוקות א', tier: 3,
      };
      await upload({
        token, path: '/api/external-enrollments/import',
        fileName: 'contracts_baby.xlsx',
        buffer: sheetBuffer(CONTRACTS_HEADER, [contractRow(baby)], 'Worksheet 1'),
        fields: { branch_id: branchId, academic_year: YEAR },
      });
      await upload({
        token, path: '/api/external-enrollments/import',
        fileName: 'Registrations Export.xlsx',
        buffer: sheetBuffer(REGISTRATIONS_HEADER, [registrationRow({
          ...baby, parentFirst: 'הורה20', parentPhone: '0500000020',
        })], 'Sheet1'),
        fields: { branch_id: branchId, academic_year: YEAR },
      });

      const row = (await listRows()).enrollments[0];
      eq(row?.computed?.age_group, 'תינוק', '20b לפי הקבצים היא תינוקת');
      eq(row?.fee_by_tier, 3000, '20c ולפי שכבתה שלה דרגה 3 היא 3,000 ₪');
      // אותה דרגה, שלוש השכבות — זה מה שמאפשר למסך להראות את התא הנכון.
      eq(row?.fees_by_group, { 'תינוק': 3000, 'פעוט': 3100, 'בוגר': 3200 },
        '20d והשרת מוסר את כל שורת הדרגה, לא רק תא אחד');

      const res = await request({
        method: 'POST', token, path: '/api/tmt/placement/confirm',
        body: {
          branch_id: branchId,
          academic_year: YEAR,
          assignments: [{ id: row.id, classroom_id: String(seniorRoom._id) }],
          fees_by_age_group: {},
          registration_fee: 0,
        },
      });
      const placed = res.body?.details?.[0];
      ok(res.status === 200 && res.body?.placed === 1,
        '20e השיבוץ לחדר הבוגרים מצליח', `${res.status} ${JSON.stringify(res.body?.skipped)}`);
      eq(placed?.age_group, 'בוגר', '20f החדר קבע את השכבה');
      eq(placed?.monthly_fee, 3200, '20g והחיוב הוא עמודת הבוגרים של דרגה 3');
      eq(placed?.monthly_fee, row?.fees_by_group?.['בוגר'],
        '20h — בדיוק המספר ש-fees_by_group הבטיח למסך');
      eq(placed?.fee_source, 'tier', '20i ומקורו בדרגה, לא בסכום ידני');
      eq(placed?.fee_tier, 'דרגה 3', '20j עם שם השורה במחירון');
    }

    /* ================================================================ *
     * בדיקה 21 — שדה שכבה ריק אינו "לעקוף ל-0"
     *
     * `Number('' ?? 0)` הוא 0, ולכן שכבה שאיש לא נגע בה נשלחה כאילו מישהו
     * בחר עבורה אפס — ועם `override_tier` השרת ציית ומחק שכר לימוד שהדרגה
     * של המשפחה תמחרה נכון. מנהלת שעוקפת את המטריצה לבוגרים אינה מאפסת בכך
     * את התינוקות.
     * ================================================================ */
    head('בדיקה 21 — עקיפת דרגה: שכבה שנשארה ריקה נשארת לפי המחירון');
    {
      const { Classroom } = require('../src/models');
      const seniorRoom = await Classroom.findOne({ branch_id: branch._id, category: 'בוגרים' });
      await wipe();
      const kid = {
        id: '5002', first: 'נועם', last: 'בוגר', idNumber: '249880002',
        birth: [2024, 1, 5], cls: 'בוגרים א', tier: 3,
      };
      await upload({
        token, path: '/api/external-enrollments/import',
        fileName: 'contracts_override.xlsx',
        buffer: sheetBuffer(CONTRACTS_HEADER, [contractRow(kid)], 'Worksheet 1'),
        fields: { branch_id: branchId, academic_year: YEAR },
      });
      await upload({
        token, path: '/api/external-enrollments/import',
        fileName: 'Registrations Export.xlsx',
        buffer: sheetBuffer(REGISTRATIONS_HEADER, [registrationRow({
          ...kid, parentFirst: 'הורה21', parentPhone: '0500000021',
        })], 'Sheet1'),
        fields: { branch_id: branchId, academic_year: YEAR },
      });
      const row = (await listRows()).enrollments[0];

      const res = await request({
        method: 'POST', token, path: '/api/tmt/placement/confirm',
        body: {
          branch_id: branchId,
          academic_year: YEAR,
          assignments: [{ id: row.id, classroom_id: String(seniorRoom._id) }],
          // העקיפה מסומנת, אבל שכבת הבוגרים נשארה ריקה — כפי שהמסך שולח אותה.
          fees_by_age_group: { 'תינוק': '1111', 'פעוט': '', 'בוגר': '' },
          override_tier: true,
          registration_fee: 0,
        },
      });
      const placed = res.body?.details?.[0];
      ok(res.status === 200 && res.body?.placed === 1,
        '21a הקליטה מצליחה', `${res.status} ${JSON.stringify(res.body?.skipped)}`);
      eq(placed?.monthly_fee, 3200, '21b שדה ריק אינו עקיפה — המחיר נשאר של הדרגה');
      eq(placed?.fee_source, 'tier', '21c ומסומן ככזה');
    }

    /* ---- ואפס שהוקלד במפורש עדיין עוקף ---- */
    {
      const { Classroom } = require('../src/models');
      const seniorRoom = await Classroom.findOne({ branch_id: branch._id, category: 'בוגרים' });
      await wipe();
      const kid = {
        id: '5003', first: 'איתי', last: 'אפס', idNumber: '249880003',
        birth: [2024, 1, 5], cls: 'בוגרים א', tier: 3,
      };
      await upload({
        token, path: '/api/external-enrollments/import',
        fileName: 'contracts_zero.xlsx',
        buffer: sheetBuffer(CONTRACTS_HEADER, [contractRow(kid)], 'Worksheet 1'),
        fields: { branch_id: branchId, academic_year: YEAR },
      });
      await upload({
        token, path: '/api/external-enrollments/import',
        fileName: 'Registrations Export.xlsx',
        buffer: sheetBuffer(REGISTRATIONS_HEADER, [registrationRow({
          ...kid, parentFirst: 'הורה21ב', parentPhone: '0500000022',
        })], 'Sheet1'),
        fields: { branch_id: branchId, academic_year: YEAR },
      });
      const row = (await listRows()).enrollments[0];
      const res = await request({
        method: 'POST', token, path: '/api/tmt/placement/confirm',
        body: {
          branch_id: branchId,
          academic_year: YEAR,
          assignments: [{ id: row.id, classroom_id: String(seniorRoom._id) }],
          fees_by_age_group: { 'בוגר': '0' },
          override_tier: true,
          registration_fee: 0,
        },
      });
      const placed = res.body?.details?.[0];
      eq(placed?.monthly_fee, 0, '21d אפס שהוקלד הוא החלטה — והוא עוקף');
      eq(placed?.fee_source, 'override', '21e ומתועד כעקיפה');
      eq(placed?.fee_tier, 'דרגה 3', '21f עם הדרגה שנעקפה');
    }
    await BranchPricing.deleteMany({ branch_id: branch._id });
  }

  head('בדיקה 22 — תנאי התשלום מגיעים למסך ההצלבה, ופרטי הבנק לא');
  {
    /**
     * THE STORY. המשרד רואה בטבלה צ׳יפ צבעוני של אמצעי התשלום, וזה כל מה שהיה
     * לו: איזה כרטיס, איזו קבלה, האם יש הו"ק בכלל — כל אלה היו בקובץ מהיום
     * הראשון ולא הוצגו באף מקום. `payment_terms` הוא הבלוק הזה.
     *
     * AND THE HALF THAT MUST NOT TRAVEL. reconcile() קורא את standing_order —
     * בלעדיו כל משפחה בהו"ק הייתה מדווחת כחסרת פרטי בנק — ולכן הבדיקה כאן היא
     * לא "השדה לא נטען" אלא "השדה נטען ולא יצא": קוד בנק, מספר חשבון ושם בעל
     * החשבון אינם מופיעים בגוף התשובה בשום צורה. אותה בדיקה בדיוק שיש על
     * /external-enrollments (5k), על הנתיב השני.
     */
    await wipe();
    const kid = {
      id: '337301', first: 'הדס', last: 'נחמיאס', idNumber: '247777775',
      birth: [2025, 3, 11], cls: 'פעוטות א', tier: 4,
    };
    // רק בייצוא החוזים — לקובץ הזה אין עמודת תשלום בכלל, ולכן אין לשורה תנאים.
    const contractOnly = {
      id: '337302', first: 'איתן', last: 'ורדי', idNumber: '246666668',
      birth: [2025, 4, 2], cls: 'פעוטות ב', tier: 5,
    };
    // כאן קליקטאק כתב את המספר המלא (או מסוכה) בתא, לא רק ארבע ספרות — הבדיקה
    // האמיתית של 22r-22u היא שהמנתח קוצר אותו לפני שהוא נשמר, ולא הצג בלבד.
    const kidLongCard = {
      id: '337303', first: 'עידו', last: 'בר', idNumber: '245555559',
      birth: [2025, 5, 6], cls: 'פעוטות א', tier: 4,
    };
    const LONG_CARD = '4580-1234-5678-9012';
    await upload({
      token, path: '/api/external-enrollments/import',
      fileName: 'contracts_terms.xlsx',
      buffer: sheetBuffer(CONTRACTS_HEADER,
        [contractRow(kid), contractRow(contractOnly), contractRow(kidLongCard)],
        'Worksheet 1'),
      fields: { branch_id: branchId, academic_year: YEAR },
    });
    await upload({
      token, path: '/api/external-enrollments/import',
      fileName: 'Registrations Export.xlsx',
      buffer: sheetBuffer(REGISTRATIONS_HEADER, [registrationRow({
        ...kid, parentFirst: 'הורה22', parentPhone: '0500000022',
        method: 'הוראת קבע',
        regFeeMethod: 'כרטיס אשראי', regFeeCard: '4242', receipt: 'RC-22001',
        amount: 350, voucher: 'SH-9001', tuitionCard: '7788', secondSigner: 'נחתם',
        soBank: '12', soBranch: '345', soAccount: '99887766', soHolder: 'דנה נחמיאס',
      }), registrationRow({
        ...kidLongCard, parentFirst: 'הורה22ב', parentPhone: '0500000023',
        method: 'כרטיס אשראי',
        regFeeMethod: 'כרטיס אשראי', regFeeCard: LONG_CARD,
        tuitionCard: LONG_CARD,
      })], 'Sheet1'),
      fields: { branch_id: branchId, academic_year: YEAR },
    });

    const res = await request({
      token,
      path: `/api/tmt/reconcile?branch=${branchId}&year=${encodeURIComponent(YEAR)}`,
    });
    ok(res.status === 200, '22a מסך ההצלבה נטען', `${res.status} ${res.text?.slice(0, 200)}`);
    const rows = res.body?.rows || [];
    const merged = rows.find(r => r.id_number === kid.idNumber);
    const terms = merged?.clicktac?.payment_terms;

    ok(!!terms, '22b לשורה שהגיעה גם מייצוא הנרשמים יש תנאי תשלום');
    eq(terms?.tuition_method, 'הוראת קבע', '22c צורת תשלום שכ"ל, כלשון הקובץ');
    eq(terms?.tuition_card_last4, '7788', '22d ארבע ספרות הכרטיס של שכר הלימוד');
    eq(terms?.registration_fee_method, 'כרטיס אשראי', '22e צורת תשלום דמי הרישום');
    eq(terms?.registration_fee_card_last4, '4242', '22f והכרטיס שלה — אחר');
    // סכום תשלום הוא עמודה כללית בקובץ — אין בה שום דבר שמייחס אותה לדמי
    // רישום ולכן היא נקראת amount_in_file ולא registration_fee_amount.
    eq(terms?.amount_in_file, 350, '22g הסכום הכללי שבקובץ, בלי לייחס אותו לדמי רישום');
    eq(terms?.receipt_number, 'RC-22001', '22h מספר הקבלה');
    eq(terms?.voucher_number, 'SH-9001', '22i מספר השובר');
    eq(terms?.second_signer, 'נחתם', '22j והחותם השני');
    // המילה היחידה שהו"ק מייצרת בתשובה.
    eq(terms?.standing_order_status, 'complete', '22k ההו"ק מדווחת כקיימת — מילה, לא חשבון');
    eq(merged?.clicktac?.payment_alert, null, '22l ולכן אין התרעה על פרטי בנק חסרים');

    const contractRowOut = rows.find(r => r.id_number === contractOnly.idNumber);
    eq(contractRowOut?.clicktac?.payment_terms, null,
      '22m לשורה שרק מייצוא החוזים אין תנאי תשלום — לקובץ ההוא אין עמודת תשלום');

    // הכרטיס המלא (או המסוכה) שקליקטאק כתב בתא — המנתח קוצר אותו לפני
    // השמירה, כך ש-9012 בלבד יוצא, גם כשהתא עצמו הכיל 16 ספרות ומקפים.
    const termsLong = rows.find(r => r.id_number === kidLongCard.idNumber)?.clicktac?.payment_terms;
    ok(!!termsLong, '22r לשורת הכרטיס המלא יש תנאי תשלום');
    eq(termsLong?.tuition_card_last4, '9012', '22s רק ארבע הספרות האחרונות של שכר הלימוד נשמרות');
    eq(termsLong?.registration_fee_card_last4, '9012', '22t וגם של דמי הרישום, אחר או לא');

    /**
     * הבדיקה שבאמת מגינה: הגוף כולו, ולא שדה ספציפי. אם מישהו יחזיר יום אחד
     * את standing_order לתשובה — בשם אחר, בתוך אובייקט אחר — היא תיפול.
     */
    const body = JSON.stringify(res.body);
    ok(!body.includes('99887766'), '22n מספר החשבון אינו בגוף התשובה');
    ok(!body.includes('דנה נחמיאס'), '22o ושם בעל החשבון אינו בו');
    ok(!/"(bank|account|holder_name)"\s*:/.test(body),
      '22p ואין בו בכלל שדה של פרטי בנק');
    ok(rows.every(r => r.clicktac?.standing_order === undefined),
      '22q אף שורה אינה נושאת את תת־המסמך standing_order');
    ok(!body.includes(LONG_CARD) && !body.includes(LONG_CARD.replace(/-/g, '')),
      '22u מספר הכרטיס המלא — עם מקפים או בלעדיהם — אינו מופיע בגוף התשובה בכלל');

    /**
     * THE SAME DATA, AS THE WORKBOOK. תנאי התשלום, הכיתה, הדרגה, השכ"ל שהיא
     * מייצרת, המקור וההתרעה — כל אלה נדרשו על ידי הבעלים כעמודות בגיליון
     * "הכל", כדי שאפשר יהיה לעבוד על הרשימה בלי לפתוח כל שורה במסך. אותם
     * הילדים, אותו ה-branch, בלי קליטה נוספת.
     */
    const { BranchPricing } = require('../src/models');
    await BranchPricing.findOneAndUpdate(
      { branch_id: branch._id, academic_year: YEAR },
      { $set: {
        branch_id: branch._id,
        academic_year: YEAR,
        pricing_type: 'subsidized',
        age_groups: ['תינוק', 'פעוט', 'בוגר'],
        tiers: [
          { label: 'דרגה 1', prices: [100, 110, 120] },
          { label: 'דרגה 2', prices: [200, 210, 220] },
          { label: 'דרגה 3', prices: [300, 310, 320] },
          { label: 'דרגה 4', prices: [400, 410, 420] },
        ],
      } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    const exportRes = await requestBuffer({
      token, path: `/api/tmt/reconcile/export?branch=${branchId}&year=${encodeURIComponent(YEAR)}`,
    });
    ok(exportRes.status === 200, '22v הייצוא נטען', String(exportRes.status));
    const wb = XLSX.read(exportRes.buffer, { type: 'buffer' });
    ok(wb.SheetNames.includes('הכל'), '22w יש גיליון "הכל"');

    const EXPECTED_HEADERS = [
      'שם הילד/ה', 'ת"ז', 'תאריך לידה', 'שכבת גיל', 'גיל ב־1.9', 'חודשים ב־1.9',
      'שובץ ידנית ל', 'מסקנה', 'פעולה נדרשת', 'חריגות', 'החלטת תמ"ת', 'תאריך כניסה בתמ"ת',
      'ברשימת תמ"ת', 'סטטוס קליקטאק', 'חתימה', 'אמצעי תשלום', 'אמצעי תשלום — כפי שנרשם',
      'כיתה', 'דרגה', 'שכ"ל לפי דרגה', 'התרעת תשלום', 'מקור', 'חסר פרטי הורים',
      'שכ"ל — אמצעי', 'כרטיס (4 ספרות)', 'דמי רישום — אמצעי', 'סכום בקובץ', 'מספר קבלה',
      'הו"ק', 'ממשיך', 'חותם שני', 'הורה 1', 'טלפון 1', 'הורה 2', 'טלפון 2',
      'איש קשר תמ"ת', 'טלפון תמ"ת', 'מייל', 'כתובת', 'במערכת',
    ];
    const asRows = XLSX.utils.sheet_to_json(wb.Sheets['הכל'], { header: 1, defval: '' });
    const headerRow = asRows[0] || [];
    eq(headerRow, EXPECTED_HEADERS,
      '22x כותרות גיליון "הכל" כוללות את עמודות בקשה 20/1, בסדר הנכון');

    const idx = Object.fromEntries(EXPECTED_HEADERS.map((h, i) => [h, i]));
    const dataRows = asRows.slice(1);
    const kidRow = dataRows.find(r => String(r[idx['ת"ז']]) === kid.idNumber);
    ok(!!kidRow, '22y שורת הדס נחמיאס נמצאת בגיליון "הכל"');
    eq(kidRow?.[idx['כיתה']], kid.cls, '22z הכיתה יצאה לגיליון');
    eq(String(kidRow?.[idx['דרגה']]), String(kid.tier), '22aa והדרגה');
    eq(kidRow?.[idx['שכ"ל לפי דרגה']], 410, '22ab שכר הלימוד לפי הדרגה, מהמטריצה שהוגדרה לבדיקה');
    ok(typeof kidRow?.[idx['שכ"ל לפי דרגה']] === 'number', '22ac ויצא כמספר, לא כטקסט');
    eq(kidRow?.[idx['התרעת תשלום']], '', '22ad אין התרעת תשלום — ההו"ק מלאה');
    eq(kidRow?.[idx['מקור']], 'נרשמים+חוזים', '22ae המקור — שני הקבצים');
    eq(kidRow?.[idx['חסר פרטי הורים']], '', '22af יש פרטי הורים — התא ריק, לא "לא"');
    eq(kidRow?.[idx['שכ"ל — אמצעי']], 'הוראת קבע', '22ag אמצעי התשלום לשכ"ל, כלשון הקובץ');
    eq(kidRow?.[idx['כרטיס (4 ספרות)']], '7788', '22ah ארבע ספרות כרטיס שכר הלימוד');
    eq(kidRow?.[idx['דמי רישום — אמצעי']], 'כרטיס אשראי', '22ai אמצעי דמי הרישום');
    eq(kidRow?.[idx['סכום בקובץ']], 350, '22aj הסכום הכללי שבקובץ, כמספר');
    ok(typeof kidRow?.[idx['סכום בקובץ']] === 'number', '22ak ויצא כמספר, לא כטקסט');
    eq(kidRow?.[idx['מספר קבלה']], 'RC-22001', '22al מספר הקבלה');
    eq(kidRow?.[idx['הו"ק']], 'קיימת', '22am ההו"ק — מילה, לא חשבון');
    eq(kidRow?.[idx['ממשיך']], '', '22an לא סומן/ה כממשיך/ה');
    eq(kidRow?.[idx['חותם שני']], 'נחתם', '22ao והחותם השני יצא לעמודה שלו — כמידע בלבד');

    const contractOnlyRow = dataRows.find(r => String(r[idx['ת"ז']]) === contractOnly.idNumber);
    ok(!!contractOnlyRow, '22ap שורת החוזה-בלבד נמצאת בגיליון');
    eq(contractOnlyRow?.[idx['מקור']], 'חוזים', '22aq מקורה — ייצוא החוזים בלבד');
    eq(contractOnlyRow?.[idx['חסר פרטי הורים']], 'כן', '22ar וחסרת פרטי הורים');

    // הממצא "חותם שני טרם חתם בקליקטאק" בוטל — לא רק אצל הדס, בשום גיליון.
    const wholeBook = wb.SheetNames
      .map(name => JSON.stringify(XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' })))
      .join('\n');
    ok(!wholeBook.includes('טרם נחתם'),
      '22as הממצא "חותם שני טרם חתם בקליקטאק" אינו מופיע באף גיליון בקובץ');

    // ואותה הגנה על פרטי הבנק כמו על ה-JSON למעלה — הפעם על הקובץ כולו,
    // כל גיליון וכל תא, ולא רק על שורת הדס.
    ok(!wholeBook.includes('99887766'), '22at מספר החשבון אינו מופיע באף תא, באף גיליון');
    ok(!wholeBook.includes('דנה נחמיאס'), '22au ושם בעל החשבון אינו');
    ok(!wholeBook.includes(LONG_CARD) && !wholeBook.includes(LONG_CARD.replace(/-/g, '')),
      '22av והכרטיס המלא (עם מקפים או בלעדיהם) אינו מופיע באף תא, באף גיליון');

    await BranchPricing.deleteMany({ branch_id: branch._id });
  }

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} בדיקות עברו`);
}

main()
  .catch((err) => { console.error('\n💥', err); failures++; })
  .finally(async () => {
    try { if (server) await new Promise(r => server.close(r)); } catch { /* closing */ }
    try { await mongoose.disconnect(); } catch { /* disconnecting */ }
    try { if (mongod) await mongod.stop(); } catch { /* stopping */ }
    process.exit(failures === 0 ? 0 : 1);
  });
