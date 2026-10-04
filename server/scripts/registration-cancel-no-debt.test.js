#!/usr/bin/env node
/**
 * "הילד/ה עזב/ה, המשפחה לא חייבת" — off the rosters and off גבייה in one step,
 * with nothing erased.
 *
 * The only one-step way out of גבייה used to be DELETE, which erases the
 * registration, the children and everything hanging off them. The safe path —
 * cancel, then settle — was two actions, so the destructive one got used for
 * children who simply left (קפלן, 10.2026). `no_debt` on cancel folds the
 * settle into the cancel, for the same roles that may settle.
 *
 *   node scripts/registration-cancel-no-debt.test.js
 */

/* Nothing may read server/.env — stub dotenv before config/env loads it. */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let failures = 0;
const eq = (a, b, l) => {
  const g = a === b;
  console.log(`  ${g ? '✅' : '❌'} ${l}${g ? '' : ` (${a} ≠ ${b})`}`);
  if (!g) failures++;
};

function call(fn, { params, body, user }) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); },
    };
    fn({ params, body, user }, res, reject);
  });
}

(async () => {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  const { Registration, Child, Collection } = require('../src/models');
  const { cancel } = require('../src/controllers/registration.controller');

  let n = 0;
  const makeReg = async () => {
    n += 1;
    const reg = await Registration.create({
      unique_id: `u${n}`, child_name: `ילד ${n}`, parent_name: 'הורה', monthly_fee: 4000,
      start_date: new Date('2026-09-01'), end_date: new Date('2027-08-31'), status: 'completed',
    });
    await Child.create({ registration_id: reg._id, child_name: reg.child_name, academic_year: '2026-2027', is_active: true });
    return reg;
  };
  const admin = { id: new mongoose.Types.ObjectId(), role: 'system_admin' };
  const manager = { id: new mongoose.Types.ObjectId(), role: 'branch_manager' };

  console.log('\nביטול עם "לא חייבת" — אדמין');
  {
    const reg = await makeReg();
    const r = await call(cancel, { params: { id: String(reg._id) }, body: { no_debt: true, note: 'עזב' }, user: admin });
    eq(r.status, 200, 'מצליח בלי חודש יציאה');
    const after = await Registration.findById(reg._id).lean();
    eq(after.status, 'cancelled', 'הרישום מבוטל — לא נמחק');
    eq(after.billing_settled, true, 'החוב סגור — יורד מהגבייה');
    eq(String(after.billing_settled_by), String(admin.id), 'נרשם מי סגר');
    eq(await Child.countDocuments({ registration_id: reg._id }), 1, 'הילד/ה נשמר/ה (היסטוריה)');
    eq(await Child.countDocuments({ registration_id: reg._id, is_active: true }), 0, 'אבל לא פעיל/ה');
  }

  console.log('\nמנהלת סניף לא יכולה לסגור חוב');
  {
    const reg = await makeReg();
    const r = await call(cancel, { params: { id: String(reg._id) }, body: { no_debt: true, exit_month: 10 }, user: manager });
    eq(r.status, 403, 'נדחה');
    const after = await Registration.findById(reg._id).lean();
    eq(after.status, 'completed', 'ושום דבר לא השתנה');
  }

  console.log('\nביטול רגיל — כמו קודם');
  {
    const reg = await makeReg();
    const missing = await call(cancel, { params: { id: String(reg._id) }, body: {}, user: manager });
    eq(missing.status, 400, 'בלי חודש יציאה ובלי "לא חייבת" — נדחה');
    const r = await call(cancel, { params: { id: String(reg._id) }, body: { exit_month: 10 }, user: manager });
    eq(r.status, 200, 'עם חודש יציאה — מצליח');
    const after = await Registration.findById(reg._id).lean();
    eq(after.billing_settled, false, 'נשאר בגבייה עד סגירת החוב');
    const col = await Collection.findOne({ registration_id: reg._id }).lean();
    eq(col && col.exit_month, 10, 'חודש היציאה נרשם בגבייה');
  }

  await mongoose.disconnect();
  await mongod.stop();
  console.log(failures ? `\n${failures} FAILED` : '\nכל הבדיקות עברו');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
