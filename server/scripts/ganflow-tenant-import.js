#!/usr/bin/env node
/**
 * Put a new customer's existing records into their system.
 *
 * THE GAP THIS FILLS. A gan signs, gets a database and a login, and then faces
 * an empty screen holding a spreadsheet of two hundred children. The importers
 * already here read one fixed format — the one גן החלומות receives from
 * קליקטאק — and a new customer's spreadsheet has different columns every single
 * time. Nobody types two hundred children in by hand, so this is the difference
 * between a customer who is set up and a customer who signed.
 *
 * SO THE COLUMNS ARE MAPPED, NOT ASSUMED. The first run reads the file, prints
 * the headers it found, guesses what each one is, and writes NOTHING. The
 * operator corrects the guesses and runs again. Guessing silently and importing
 * is how a phone number ends up in the medical notes.
 *
 * IT REFUSES TO WRITE WITHOUT --yes, and it says what it would do first: how
 * many rows, how many are already there, and which rows it cannot use and why.
 * A row it does not understand is REPORTED AND SKIPPED — never half-imported.
 * Half a child is worse than no child: nobody goes looking for the missing half.
 *
 * IT CAN BE RUN TWICE. Children are matched on name plus date of birth,
 * employees on identity number. An import that duplicates everything on the
 * second run is one nobody dares re-run after fixing three rows, which means
 * they fix the three rows by hand and the file and the system drift apart.
 *
 *   node scripts/ganflow-tenant-import.js --slug X --file kids.xlsx --what children
 *   ... --map "child_name=שם הילד,birth_date=ת. לידה,parent_name=הורה" --branch "סניף א" --yes
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config();

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const SLUG = opt('slug');
const FILE = opt('file');
const WHAT = opt('what', 'children');
const BRANCH = opt('branch');
const YEAR = opt('year');
const MAP_ARG = opt('map', '');
const WRITE = argv.includes('--yes');

function die(m) { console.error(`\n❌  ${m}\n`); process.exit(1); }

if (!SLUG) die('חסר --slug');
if (!FILE) die('חסר --file');
if (!fs.existsSync(FILE)) die(`הקובץ לא נמצא: ${FILE}`);
if (!['children', 'employees'].includes(WHAT)) die('--what חייב להיות children או employees');
if (!process.env.PLATFORM_MONGODB_URI) die('חסר PLATFORM_MONGODB_URI');

// ---------------------------------------------------------------- the fields
//
// Only what a gan actually has in a spreadsheet. Everything else the system
// needs it works out itself, and asking an operator to map a field the file
// does not contain is how a mapping gets filled in with something wrong.
const FIELDS = {
  children: {
    child_name: { label: 'שם הילד/ה', required: true, hints: [/שם.*ילד/, /^שם$/, /ילד/, /name/i] },
    birth_date: { label: 'תאריך לידה', required: false, hints: [/לידה/, /birth/i, /תאריך.*לד/] },
    child_id_number: { label: 'ת"ז הילד/ה', required: false, hints: [/ת.?ז.*ילד/, /זהות.*ילד/] },
    parent_name: { label: 'שם ההורה', required: false, hints: [/הור/, /אמא/, /אבא/, /parent/i] },
    phone: { label: 'טלפון', required: false, hints: [/טלפון/, /נייד/, /phone/i, /mobile/i] },
    email: { label: 'אימייל', required: false, hints: [/מייל/, /דוא/, /mail/i] },
    address: { label: 'כתובת', required: false, hints: [/כתובת/, /address/i] },
    medical_alerts: { label: 'הערות רפואיות', required: false, hints: [/רפוא/, /אלרג/, /medical/i] },
  },
  employees: {
    full_name: { label: 'שם מלא', required: true, hints: [/שם.*מלא/, /^שם$/, /עובד/, /name/i] },
    id_number: { label: 'תעודת זהות', required: false, hints: [/ת.?ז/, /זהות/, /israeli/i, /\bid\b/i] },
    phone: { label: 'טלפון', required: false, hints: [/טלפון/, /נייד/, /phone/i] },
    email: { label: 'אימייל', required: false, hints: [/מייל/, /דוא/, /mail/i] },
    position: { label: 'תפקיד', required: false, hints: [/תפקיד/, /role/i, /position/i] },
    start_date: { label: 'תחילת עבודה', required: false, hints: [/תחילת/, /התחל/, /start/i] },
  },
};

/** A date a person typed. Israeli files say 05/09/2023 and mean September. */
function parseDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const s = String(v).trim();
  const dmy = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (dmy) {
    let [, d, m, y] = dmy;
    if (y.length === 2) y = String(2000 + Number(y));
    const dt = new Date(Number(y), Number(m) - 1, Number(d));
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  const dt = new Date(s);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

const clean = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());

(async () => {
  const xlsx = require('xlsx');
  const wb = xlsx.readFile(FILE, { cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(sheet, { defval: '' });
  if (!rows.length) die('הגיליון ריק');

  const headers = Object.keys(rows[0]);
  const spec = FIELDS[WHAT];

  // Guess, then let the operator disagree.
  const guess = {};
  for (const [field, def] of Object.entries(spec)) {
    const hit = headers.find((h) => def.hints.some((rx) => rx.test(h)));
    if (hit) guess[field] = hit;
  }
  for (const pair of MAP_ARG.split(',').map((x) => x.trim()).filter(Boolean)) {
    const i = pair.indexOf('=');
    if (i === -1) die(`מיפוי לא תקין: "${pair}" — צריך שדה=עמודה`);
    const field = pair.slice(0, i).trim();
    const col = pair.slice(i + 1).trim();
    if (!spec[field]) die(`אין שדה בשם "${field}". השדות: ${Object.keys(spec).join(', ')}`);
    if (!headers.includes(col)) die(`אין עמודה בשם "${col}" בקובץ. העמודות: ${headers.join(' | ')}`);
    guess[field] = col;
  }

  console.log(`\n📄  ${path.basename(FILE)} — ${rows.length} שורות, ${headers.length} עמודות\n`);
  console.log('   עמודות בקובץ: ' + headers.join(' | ') + '\n');
  console.log('   מיפוי:');
  for (const [field, def] of Object.entries(spec)) {
    const col = guess[field];
    const mark = col ? '✓' : (def.required ? '❌' : '·');
    console.log(`     ${mark}  ${def.label.padEnd(16)} ← ${col || '(לא מופה)'}`);
  }

  const missingRequired = Object.entries(spec).filter(([f, d]) => d.required && !guess[f]);
  if (missingRequired.length) {
    die(`חסר מיפוי לשדה חובה: ${missingRequired.map(([, d]) => d.label).join(', ')}\n` +
        `   הוסף --map "${missingRequired[0][0]}=שם העמודה"`);
  }

  const { controlPlane, tenantConnection, closeAll } = require('../src/platform/connection');
  const { Tenant } = await controlPlane();
  const tenant = await Tenant.findOne({ slug: SLUG }).lean();
  if (!tenant) die(`לא נמצא לקוח "${SLUG}"`);
  const { models } = await tenantConnection(tenant);

  // Which branch these belong to. A customer with one branch does not have to
  // say; a customer with several must, because guessing puts a child in the
  // wrong gan and nobody notices until a parent arrives at the wrong door.
  const branches = await models.Branch.find({}).select('_id name').lean();
  let branch = null;
  if (BRANCH) {
    branch = branches.find((b) => b.name === BRANCH || String(b._id) === BRANCH);
    if (!branch) die(`אין סניף "${BRANCH}". הסניפים: ${branches.map((b) => b.name).join(' | ')}`);
  } else if (branches.length === 1) {
    branch = branches[0];
  } else {
    die(`ללקוח יש ${branches.length} סניפים — צריך --branch.\n   ${branches.map((b) => b.name).join(' | ')}`);
  }

  const year = YEAR || `${new Date().getFullYear()}-${new Date().getFullYear() + 1}`;

  const toWrite = [];
  const skipped = [];
  const already = [];

  for (const [i, row] of rows.entries()) {
    const line = i + 2;                      // +1 for the header, +1 for humans
    const get = (f) => (guess[f] ? clean(row[guess[f]]) : '');

    if (WHAT === 'children') {
      const name = get('child_name');
      if (!name) { skipped.push({ line, why: 'אין שם' }); continue; }
      const birth = parseDate(row[guess.birth_date]);
      if (guess.birth_date && !birth && clean(row[guess.birth_date])) {
        skipped.push({ line, why: `תאריך לידה לא מובן: "${clean(row[guess.birth_date])}"` });
        continue;
      }
      const dup = await models.Child.findOne({
        child_name: name, ...(birth ? { birth_date: birth } : {}),
      }).lean();
      if (dup) { already.push(name); continue; }

      toWrite.push({
        child_name: name,
        birth_date: birth,
        child_id_number: get('child_id_number'),
        parent_name: get('parent_name'),
        phone: get('phone'),
        email: get('email'),
        address: get('address'),
        medical_alerts: get('medical_alerts'),
        branch_id: branch._id,
        academic_year: year,
        is_active: true,
      });
    } else {
      const name = get('full_name');
      if (!name) { skipped.push({ line, why: 'אין שם' }); continue; }
      const id = get('id_number').replace(/\D/g, '');
      // Without an id number the person cannot log in and their clock punches
      // cannot be matched to them — so it is worth saying, and worth importing
      // anyway rather than losing the row.
      const dup = id
        ? await models.Employee.findOne({ id_number: id }).lean()
        : await models.Employee.findOne({ full_name: name, branch_id: branch._id }).lean();
      if (dup) { already.push(name); continue; }

      toWrite.push({
        full_name: name,
        id_number: id,
        phone: get('phone'),
        email: get('email'),
        position: get('position'),
        start_date: parseDate(row[guess.start_date]),
        branch_id: branch._id,
        is_active: true,
        salary_type: 'hourly',
        _noId: !id,
      });
    }
  }

  const noId = WHAT === 'employees' ? toWrite.filter((e) => e._noId).length : 0;

  console.log(`\n   סניף: ${branch.name}${WHAT === 'children' ? ` · שנה: ${year}` : ''}`);
  console.log(`\n   ${toWrite.length} ייווצרו · ${already.length} כבר קיימים · ${skipped.length} לא ניתנים לייבוא`);
  if (noId) console.log(`   \u{26A0}️  ${noId} עובדים בלי תעודת זהות — הם לא יוכלו להיכנס למערכת עד שתושלם`);

  if (skipped.length) {
    console.log('\n   שורות שידולגו:');
    skipped.slice(0, 15).forEach((s) => console.log(`     שורה ${s.line}: ${s.why}`));
    if (skipped.length > 15) console.log(`     ...ועוד ${skipped.length - 15}`);
  }

  if (toWrite.length) {
    console.log('\n   דוגמה לשורה ראשונה שתיווצר:');
    const { _noId, branch_id, ...sample } = toWrite[0];
    for (const [k, v] of Object.entries(sample)) if (v) console.log(`     ${k}: ${v}`);
  }

  if (!WRITE) {
    console.log('\n\u{1F449} לא נכתב כלום. אם המיפוי נכון — הוסף --yes\n');
    await closeAll();
    return;
  }

  if (WHAT === 'employees') {
    const docs = toWrite.map(({ _noId, ...d }) => d);
    for (let i = 0; i < docs.length; i += 500) await models.Employee.insertMany(docs.slice(i, i + 500));
    console.log(`\n✅  נוצרו ${docs.length}. הרצה חוזרת של אותו קובץ לא תיצור כפילויות.\n`);
    await closeAll();
    return;
  }

  // A child in this system does not exist without a registration — `Child`
  // requires `registration_id`, and every screen that shows a fee, a contract
  // or a collection reads it from there. Inserting the child alone passes
  // nowhere: it fails validation, and if it had not, it would have produced
  // children who cannot be billed and whose parents cannot be contacted.
  //
  // So the registration is created first and the child hangs off it, the same
  // way the registration screen does it. The fee is left at zero deliberately —
  // it is not in the spreadsheet, and inventing one is worse than an obvious
  // blank somebody has to fill in.
  let made = 0;
  for (const row of toWrite) {
    const reg = await models.Registration.create({
      unique_id: `IMP-${Date.now()}-${made}`,
      child_name: row.child_name,
      child_birth_date: row.birth_date,
      parent_name: row.parent_name || '—',
      parent_phone: row.phone,
      parent_email: row.email,
      monthly_fee: 0,                       // not in the file; an obvious blank
      start_date: new Date(),
      end_date: new Date(new Date().getFullYear() + 1, 7, 31),
      branch_id: row.branch_id,
      academic_year: row.academic_year,
      status: 'completed',
    });
    await models.Child.create({ ...row, registration_id: reg._id });
    made += 1;
  }

  console.log(`\n✅  נוצרו ${made} ילדים, כל אחד עם רישום.`);
  console.log('   \u{26A0}️  שכר הלימוד נשאר 0 — הוא לא היה בקובץ. יש להשלים אותו במסך הגבייה.');
  console.log('   הרצה חוזרת של אותו קובץ לא תיצור כפילויות.\n');
  await closeAll();
})().catch((e) => { console.error(e); process.exit(1); });
