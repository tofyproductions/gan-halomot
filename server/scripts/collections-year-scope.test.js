/**
 * שני דברים על טבלת הגבייה: הנחה שייכת לשנה אחת, ולמשפחה יש הערה משלה.
 *
 * 1. הנחה היא אירוע חד-פעמי.
 *
 *    ה-50% של "מבצע שאגת הארי" ניתנו לאפריל של תשפ"ו ולו בלבד. השאילתה שקראה
 *    את ההנחות שכחה לסנן לפי `academic_year`, ולכן אותה הנחה ירדה מאפריל גם
 *    בתשפ"ז — ומכל אפריל שאחריו, לנצח. `academic_year` ישב על המודל מההתחלה;
 *    רק הקריאה התעלמה ממנו.
 *
 *    זאת בדיקה של השאילתה, לא של החשבון. `discountFor` תמיד עבד נכון על מה
 *    שהוגש לו — הבאג היה במה שהוגש. לכן היא חייבת בסיס נתונים אמיתי.
 *
 * 2. `Collection.notes` — הערה על המשפחה, לא על חודש.
 *
 *    `months[].notes` היא על תשלום של חודש מסוים ומוצגת בתוך התא שלו. זאת
 *    אחרת: "משלמת במזומן תמיד", "לתאם מול הרווחה". היא שייכת לשורה, ולכן היא
 *    עמודה בסוף הטבלה ושדה ברמת הכרטיס.
 *
 *   node scripts/collections-year-scope.test.js
 */

/* Nothing here may read server/.env. Stub dotenv before anything loads it. */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

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

const LAST_YEAR = '2025-2026';
const THIS_YEAR = '2026-2027';
const FEE = 1000;
const APRIL = 4;

/**
 * A caller the branch filter lets see everything.
 *
 * `branchScope: null` is what attachBranchScope sets for a system_admin, and
 * it is the field getBranchFilter actually reads — a role alone leaves the
 * scope undefined, which fails closed to "no branch" and returns an empty
 * table. See utils/branch-filter.js.
 */
const adminReq = (query = {}) => ({
  query, body: {}, branchScope: null, user: { role: 'system_admin' },
});

/** Collects a controller's res.json payload. */
function capture() {
  const out = {};
  return {
    res: {
      json: (payload) => { out.payload = payload; return out; },
      status: (code) => { out.status = code; return { json: (p) => { out.payload = p; return out; } }; },
    },
    next: (err) => { out.error = err; },
    out,
  };
}

/** The April cell of the only child in the table. */
function aprilOf(payload) {
  const rows = Object.values(payload.collections || {}).flat();
  const row = rows[0];
  if (!row) return null;
  return (row.months || []).find(m => m.month === APRIL) || null;
}

(async () => {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { dbName: 'test' });

  const M = require('../src/models');
  const ctrl = require('../src/controllers/collections.controller');

  const branch = await M.Branch.create({ name: 'סניף בדיקה', is_active: true });
  const room = await M.Classroom.create({
    name: 'צעירים', category: 'צעירים', academic_year: THIS_YEAR, branch_id: branch._id,
  });

  /** One registration per year for the same child, which is the normal shape. */
  async function makeYear(year) {
    const [y1, y2] = year.split('-').map(Number);
    const reg = await M.Registration.create({
      unique_id: `REG-${year}`,
      branch_id: branch._id,
      child_name: 'ילד בדיקה',
      classroom_id: room._id,
      parent_name: 'הורה בדיקה',
      monthly_fee: FEE,
      start_date: new Date(Date.UTC(y1, 8, 1)),
      end_date: new Date(Date.UTC(y2, 7, 31)),
      academic_year: year,
      status: 'completed',
    });
    await M.Child.create({
      registration_id: reg._id, child_name: 'ילד בדיקה',
      academic_year: year, classroom_id: room._id, is_active: true,
    });
    return reg;
  }

  const regLast = await makeYear(LAST_YEAR);
  const regThis = await makeYear(THIS_YEAR);

  // The credit exactly as it sits in production: branch-wide, April, 50%.
  await M.Discount.create({
    branch_id: branch._id, scope: 'branch',
    discount_type: 'percentage', value: 50, month: APRIL,
    academic_year: LAST_YEAR,
    reason: 'החזרים בעקבות מבצע שאגת הארי',
    is_active: true,
  });

  head('ההנחה חלה על השנה שניתנה בה');
  {
    const { res, next, out } = capture();
    await ctrl.getAll(adminReq({ year: LAST_YEAR }), res, next);
    ok(!out.error, 'הטבלה נטענה', out.error?.message);
    const april = aprilOf(out.payload);
    eq(april?.discount_amount, FEE / 2, 'אפריל תשפ"ו — ההנחה ירדה');
    eq(april?.expected_amount, FEE / 2, 'ולכן הצפוי הוא חצי');
  }

  head('ועל אף שנה אחרת — זה הבאג שהתגלה');
  {
    const { res, next, out } = capture();
    await ctrl.getAll(adminReq({ year: THIS_YEAR }), res, next);
    ok(!out.error, 'הטבלה נטענה', out.error?.message);
    const april = aprilOf(out.payload);
    eq(april?.discount_amount, 0, 'אפריל תשפ"ז — אין הנחה');
    eq(april?.expected_amount, FEE, 'והצפוי הוא שכר הלימוד המלא');
  }

  head('הנחה ישנה בלי שנה כלל אינה גולשת קדימה');
  {
    // The five rows that were in production had academic_year: ''. A blank is
    // not a wildcard — it is a row nobody stamped, and it must not price a year
    // it was never meant for.
    await M.Discount.create({
      branch_id: branch._id, scope: 'branch',
      discount_type: 'fixed', value: 300, month: APRIL,
      academic_year: '', reason: 'הנחה ישנה בלי שנה', is_active: true,
    });
    const { res, next, out } = capture();
    await ctrl.getAll(adminReq({ year: THIS_YEAR }), res, next);
    const april = aprilOf(out.payload);
    eq(april?.discount_amount, 0, 'שנה ריקה לא נספרת בתשפ"ז');
    eq(april?.expected_amount, FEE, 'הצפוי נשאר מלא');
  }

  head('הערה על המשפחה — נשמרת, חוזרת, ונפרדת מהערת החודש');
  {
    const { res, next, out } = capture();
    await ctrl.updateNotes(
      { params: { registrationId: String(regThis._id) }, body: { notes: 'משלמת במזומן תמיד', year: THIS_YEAR }, query: {}, branchScope: null, user: { role: 'system_admin' } },
      res, next,
    );
    ok(!out.error, 'השמירה עברה', out.error?.message);
    eq(out.payload?.notes, 'משלמת במזומן תמיד', 'ההערה חזרה מהשמירה');
  }
  {
    const { res, next, out } = capture();
    await ctrl.getAll(adminReq({ year: THIS_YEAR }), res, next);
    const row = Object.values(out.payload.collections || {}).flat()[0];
    eq(row?.notes, 'משלמת במזומן תמיד', 'וגם מהטבלה');
  }
  {
    // A card that never had a Collection document still takes a note — this is
    // an upsert, and the note is often the first thing written about a family.
    const created = await M.Collection.findOne({ registration_id: regThis._id, academic_year: THIS_YEAR });
    ok(!!created, 'נוצר כרטיס גבייה גם למי שלא חויב עדיין');
    eq(created?.academic_year, THIS_YEAR, 'ובשנה הנכונה');
  }
  {
    // The two notes are different fields and must not overwrite each other.
    const { res, next } = capture();
    await ctrl.updateNotes(
      { params: { registrationId: String(regLast._id) }, body: { notes: 'הערה של שנה שעברה', year: LAST_YEAR }, query: {}, branchScope: null, user: { role: 'system_admin' } },
      res, next,
    );
    const thisYear = await M.Collection.findOne({ registration_id: regThis._id, academic_year: THIS_YEAR }).lean();
    eq(thisYear?.notes, 'משלמת במזומן תמיד', 'הערה של שנה אחת לא דורסת את השנייה');
  }
  {
    const { res, next, out } = capture();
    await ctrl.updateNotes(
      { params: { registrationId: String(regThis._id) }, body: { notes: '', year: THIS_YEAR }, query: {}, branchScope: null, user: { role: 'system_admin' } },
      res, next,
    );
    ok(!out.error, 'אפשר למחוק הערה', out.error?.message);
    eq(out.payload?.notes, '', 'והיא חוזרת ריקה ולא null');
  }

  await mongoose.disconnect();
  await mongo.stop();

  console.log(failures === 0
    ? `\n✅  הכל עבר (${checks} בדיקות)\n`
    : `\n❌  ${failures} בדיקות נכשלו\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('💥 ', e); process.exit(1); });
