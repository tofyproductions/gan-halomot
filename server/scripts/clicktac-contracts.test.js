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
  COLUMNS, CONTRACT_COLUMNS, detectExportType, parseContractsRow, parseDate, idKey,
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
 * ================================================================== */

/** Excel's own day count for a date — what an unformatted date cell holds. */
function excelSerial(y, m, d) {
  return Math.round((Date.UTC(y, m - 1, d) / 86400000) + 25569);
}

function sheetBuffer(header, rows, sheetName) {
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

const CONTRACTS_HEADER = Object.values(CONTRACT_COLUMNS);

/**
 * One contracts row. The dates go in as bare Excel serials, exactly as the
 * real export has them — that is the shape the parser has to survive.
 */
function contractRow({
  id, first, last, idNumber, idType = 'ת.ז.', birth, cls, tier,
  nickname = '', medicalNotes = '',
}) {
  const by = {
    [CONTRACT_COLUMNS.contract_id]: id,
    [CONTRACT_COLUMNS.child_first]: first,
    [CONTRACT_COLUMNS.child_last]: last,
    [CONTRACT_COLUMNS.nickname]: nickname,
    [CONTRACT_COLUMNS.birth_date]: excelSerial(...birth),
    [CONTRACT_COLUMNS.birth_date_hebrew]: 'ל׳ בשבט',
    [CONTRACT_COLUMNS.id_type]: idType,
    [CONTRACT_COLUMNS.id_number]: idNumber,
    [CONTRACT_COLUMNS.health_fund]: 'מכבי',
    [CONTRACT_COLUMNS.medical_notes]: medicalNotes,
    [CONTRACT_COLUMNS.registered_at]: excelSerial(2026, 5, 3),
    [CONTRACT_COLUMNS.status]: 'התקבל',
    [CONTRACT_COLUMNS.age_group]: 'פעוט',
    [CONTRACT_COLUMNS.admin_notes]: '',
    [CONTRACT_COLUMNS.institution]: 'הרצליה',
    [CONTRACT_COLUMNS.year]: YEAR,
    [CONTRACT_COLUMNS.class_name]: cls,
    [CONTRACT_COLUMNS.tuition_type]: 'מימון משרד הכלכלה',
    [CONTRACT_COLUMNS.tier]: tier,
    [CONTRACT_COLUMNS.start_date]: excelSerial(2026, 9, 1),
    [CONTRACT_COLUMNS.end_date]: excelSerial(2027, 8, 31),
    [CONTRACT_COLUMNS.tags]: 'ספטמבר',
    [CONTRACT_COLUMNS.created_by]: 'אלון',
    [CONTRACT_COLUMNS.created_at]: excelSerial(2026, 5, 3),
    [CONTRACT_COLUMNS.updated_by]: 'אלון',
    [CONTRACT_COLUMNS.updated_at]: excelSerial(2026, 5, 3),
  };
  return CONTRACTS_HEADER.map(h => by[h] ?? '');
}

const REGISTRATIONS_HEADER = Object.values(COLUMNS);

function registrationRow({
  first, last, idNumber, birth, parentFirst, parentPhone, method = 'כרטיס אשראי',
}) {
  const [y, m, d] = birth;
  const by = {
    [COLUMNS.institution]: 'הרצליה',
    [COLUMNS.year]: YEAR,
    [COLUMNS.child_first]: first,
    [COLUMNS.child_last]: last,
    [COLUMNS.child_id]: idNumber,
    [COLUMNS.birth_date]: `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`,
    [COLUMNS.age_group]: 'פעוט',
    [COLUMNS.gender]: 'זכר',
    [COLUMNS.health_fund]: 'כללית',
    [COLUMNS.p1_first]: parentFirst,
    [COLUMNS.p1_last]: last,
    [COLUMNS.p1_id]: '311111111',
    [COLUMNS.p1_relation]: 'אם',
    [COLUMNS.p1_phone]: parentPhone,
    [COLUMNS.p1_email]: 'a@b.co.il',
    [COLUMNS.p1_address]: 'הרצל 1',
    [COLUMNS.status]: 'התקבל',
    [COLUMNS.tuition_method]: method,
  };
  return REGISTRATIONS_HEADER.map(h => by[h] ?? '');
}

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
