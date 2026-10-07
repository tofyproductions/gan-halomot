/**
 * הנחה ברמת סניף שייכת לסניף שלה בלבד.
 *
 * `discountFor` החיל כל הנחה עם `scope: 'branch'` על כל ילד שהוגש לו, בלי
 * להשוות את `branch_id` של ההנחה לסניף של הילד. במסך הגבייה של סניף אחד זה
 * לא הורגש — השאילתה כבר סיננה לפי סניף. אבל בתצוגת "כל הסניפים" של המנהל
 * נטענות ההנחות של כל הסניפים יחד, וההנחה של סניף א' ירדה גם מהילדים של סניף ב':
 * הצפוי הוקטן, וחוב יכול היה להיראות משולם.
 *
 * הבדיקה עוברת דרך הבקר האמיתי (getAll) עם בסיס נתונים בזיכרון, ובנוסף על
 * `discountFor` ישירות — כי התיקון יושב בפונקציה המשותפת, ולא בכל קורא.
 *
 *   node scripts/collections-branch-discount.test.js
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

const YEAR = '2026-2027';
const FEE = 1000;
const APRIL = 4;

/** A system_admin with no branch picked — the "all branches" view. */
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

/** The April cell of the named child. */
function aprilOf(payload, childName) {
  const rows = Object.values(payload?.collections || {}).flat();
  const row = rows.find(r => r.child_name === childName);
  if (!row) return null;
  return (row.months || []).find(m => m.month === APRIL) || null;
}

(async () => {
  const { discountFor } = require('../src/services/collection-view.service');

  head('discountFor — הנחת סניף נבדקת מול הסניף של הילד');
  {
    const A = new mongoose.Types.ObjectId();
    const B = new mongoose.Types.ObjectId();
    const d = [{ scope: 'branch', branch_id: A, discount_type: 'percentage', value: 50, month: null }];
    eq(discountFor(d, 'r1', 'c1', APRIL, FEE, A), FEE / 2, 'ילד בסניף א\' — מקבל את ההנחה');
    eq(discountFor(d, 'r2', 'c2', APRIL, FEE, B), 0, 'ילד בסניף ב\' — לא מקבל');
    eq(discountFor(d, 'r3', 'c3', APRIL, FEE, null), 0, 'ילד בלי סניף ידוע — לא מקבל');
    eq(discountFor(d, 'r1', 'c1', APRIL, FEE, String(A)), FEE / 2, 'מחרוזת ו-ObjectId נחשבים אותו סניף');
  }

  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { dbName: 'test' });

  const M = require('../src/models');
  const ctrl = require('../src/controllers/collections.controller');

  const branchA = await M.Branch.create({ name: 'סניף א', is_active: true });
  const branchB = await M.Branch.create({ name: 'סניף ב', is_active: true });

  async function makeChild(branch, name) {
    const room = await M.Classroom.create({
      name: `כיתה ${name}`, category: 'צעירים', academic_year: YEAR, branch_id: branch._id,
    });
    const [y1, y2] = YEAR.split('-').map(Number);
    const reg = await M.Registration.create({
      unique_id: `REG-${name}`,
      branch_id: branch._id,
      child_name: name,
      classroom_id: room._id,
      parent_name: `הורה של ${name}`,
      monthly_fee: FEE,
      start_date: new Date(Date.UTC(y1, 8, 1)),
      end_date: new Date(Date.UTC(y2, 7, 31)),
      academic_year: YEAR,
      status: 'completed',
    });
    await M.Child.create({
      registration_id: reg._id, child_name: name,
      academic_year: YEAR, classroom_id: room._id, is_active: true,
    });
    return reg;
  }

  await makeChild(branchA, 'ילד א');
  await makeChild(branchB, 'ילד ב');

  // A branch-wide April credit in branch A only.
  await M.Discount.create({
    branch_id: branchA._id, scope: 'branch',
    discount_type: 'percentage', value: 50, month: APRIL,
    academic_year: YEAR, reason: 'הנחה של סניף א', is_active: true,
  });

  head('תצוגת כל הסניפים — ההנחה של סניף א\' לא גולשת לסניף ב\'');
  {
    const { res, next, out } = capture();
    await ctrl.getAll(adminReq({ year: YEAR }), res, next);
    ok(!out.error, 'הטבלה נטענה', out.error?.message);

    const a = aprilOf(out.payload, 'ילד א');
    eq(a?.discount_amount, FEE / 2, 'סניף א\' — ההנחה ירדה');
    eq(a?.expected_amount, FEE / 2, 'וצפוי חצי');

    const b = aprilOf(out.payload, 'ילד ב');
    eq(b?.discount_amount, 0, 'סניף ב\' — אין הנחה (זה הבאג)');
    eq(b?.expected_amount, FEE, 'והצפוי הוא שכר הלימוד המלא');
  }

  await mongoose.disconnect();
  await mongo.stop();

  console.log(failures === 0
    ? `\n✅  הכל עבר (${checks} בדיקות)\n`
    : `\n❌  ${failures} בדיקות נכשלו\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('💥 ', e); process.exit(1); });
