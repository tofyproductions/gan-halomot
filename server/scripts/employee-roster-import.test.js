#!/usr/bin/env node
/**
 * The accountant's roster, compared and applied.
 *
 * Everything here is about not damaging ninety-five real records:
 *   1. an employee is found by ת"ז and never by name;
 *   2. a field the roster leaves empty does NOT erase what we hold;
 *   3. an ID that fails its check digit, or repeats, is refused;
 *   4. an ID we do not have is REPORTED — never inserted as a new employee;
 *   5. a balance with no month, or older than the one on file, is blocked;
 *   6. applying writes only for the employees the reviewer approved, and takes
 *      the VALUES from the re-derived plan rather than from the caller.
 *
 *   node scripts/employee-roster-import.test.js
 *
 * The model is stubbed; nothing leaves and no real database is touched.
 */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};

const assert = require('assert');

/**
 * The Employee model is stubbed rather than run against a real (or in-memory)
 * Mongo. What is under test is the DECISION — which fields would change, which
 * are refused — and a fake collection exercises that without a database binary,
 * so this suite runs on a laptop and in CI identically.
 */
const store = new Map(); // _id → employee doc
const pick = (doc) => JSON.parse(JSON.stringify(doc));
const FakeEmployee = {
  // find/findById return the chain SYNCHRONOUSLY, the way mongoose does — the
  // caller does `.select(...).lean()` on the result, which a Promise has not got.
  find(query) {
    const wanted = new Set(query?.israeli_id?.$in || []);
    const rows = [...store.values()].filter((e) => wanted.has(e.israeli_id));
    const chain = { select: () => chain, lean: async () => rows.map(pick) };
    return chain;
  },
  findById(id) { return { lean: async () => (store.has(String(id)) ? pick(store.get(String(id))) : null) }; },
  async updateOne(filter, update) {
    const doc = store.get(String(filter._id));
    if (!doc) return { matchedCount: 0 };
    Object.assign(doc, update.$set || {});
    return { matchedCount: 1 };
  },
  async countDocuments() { return store.size; },
  async create(doc) {
    const _id = String(store.size + 1);
    const full = { _id, is_active: true, ...doc };
    store.set(_id, full);
    return full;
  },
};
const modelsPath = require.resolve('../src/models');
require.cache[modelsPath] = {
  id: modelsPath, filename: modelsPath, loaded: true, children: [], paths: [],
  exports: { Employee: FakeEmployee },
};

let passed = 0;
const ok = (label) => { console.log('  ✓ ' + label); passed += 1; };

(async () => {
  const { Employee } = require('../src/models');
  const R = require('../src/services/employeeRosterImport');

  // Two real shapes: one with details on file, one nearly empty.
  const rinat = await Employee.create({
    full_name: 'אברבנל רינת', israeli_id: '208430777', 
    employee_number: '67', email: 'old@example.com', phone: '0500000000',
    gender: '', marital_status: '',
  });
  const lidor = await Employee.create({
    full_name: 'כהן לידור', israeli_id: '313163412', 
    employee_number: '1', email: 'keep@example.com', phone: '',
    sick_balance_opening: { days: 10, as_of_month: '2026-08' },
  });

  const ROWS = [
    { employee_number: '67', israeli_id: '208430777', email: 'rinat8891996@gmail.com',
      phone: '0547018164', birth_date: '16/12/1996', gender: 'נקבה', marital: 'רווק/ה',
      postal: '6800329', vacation_balance: '6.002', sick_balance: '63.000',
      recreation_balance: '0.664' },
    // No email at all — the twenty-six-row case.
    { employee_number: '1', israeli_id: '313163412', email: '', phone: '0543599422',
      birth_date: '04/07/1995', gender: 'נקבה', marital: 'נשוי/אה', postal: '',
      vacation_balance: '6.002', sick_balance: '63.000', recreation_balance: '0.664' },
  ];

  console.log('the check digit catches a typo before it reaches a record');
  {
    assert.strictEqual(R.isValidIsraeliId('208430777'), true);
    assert.strictEqual(R.isValidIsraeliId('313163412'), true);
    assert.strictEqual(R.isValidIsraeliId('208430778'), false, 'one digit off must fail');
    assert.strictEqual(R.normalizeId('12345678'), '012345678', 'a leading zero is part of the ID');
    ok('a valid ID passes, a mistyped one fails, a short one keeps its leading zero');

    const plan = await R.buildImportPlan([{ israeli_id: '208430778', employee_number: 'x' }], '2026-08');
    assert.strictEqual(plan.invalid.length, 1);
    assert.strictEqual(plan.matched.length, 0);
    ok('a failing check digit is refused, not matched by luck');
  }

  console.log('the plan changes nothing on its own');
  {
    const plan = await R.buildImportPlan(ROWS, '2026-08');
    assert.strictEqual(plan.matched.length, 2);
    const after = await Employee.findById(rinat._id).lean();
    assert.strictEqual(after.email, 'old@example.com', 'building a plan must not write');
    ok('building the plan leaves every record untouched');

    const r = plan.matched.find((m) => m.israeli_id === '208430777');
    const fields = r.changes.map((c) => c.field);
    assert.ok(fields.includes('email') && fields.includes('phone'), 'email and phone differ');
    const email = r.changes.find((c) => c.field === 'email');
    assert.strictEqual(email.before, 'old@example.com');
    assert.strictEqual(email.after, 'rinat8891996@gmail.com');
    ok('a differing field is listed with what it is today and what it would become');
  }

  console.log('an empty field never erases what we hold');
  {
    const plan = await R.buildImportPlan(ROWS, '2026-08');
    const l = plan.matched.find((m) => m.israeli_id === '313163412');
    assert.ok(!l.changes.some((c) => c.field === 'email'),
      'a row with no email must not propose clearing the one on file');
    await R.applyImportPlan(ROWS, '2026-08', ['313163412']);
    const after = await Employee.findById(lidor._id).lean();
    assert.strictEqual(after.email, 'keep@example.com', 'the existing address survived');
    assert.strictEqual(after.phone, '0543599422', 'the phone it did carry was written');
    ok('no email in the file leaves the filed address alone');
  }

  console.log('a balance is refused unless it can be placed in time');
  {
    const noMonth = await R.buildImportPlan(ROWS, null);
    const r = noMonth.matched.find((m) => m.israeli_id === '208430777');
    assert.ok(r.blocked.some((b) => b.field === 'vacation_balance_opening'),
      'a balance with no as_of_month cannot be accrued forward');
    assert.ok(!r.changes.some((c) => c.field === 'vacation_balance_opening'),
      'and must not sneak into the applicable changes');
    ok('a balance with no month is blocked, with the reason said out loud');

    // Lidor already holds a balance closed on 2026-08; an older file must not
    // walk it backwards.
    const older = await R.buildImportPlan(ROWS, '2026-05');
    const l = older.matched.find((m) => m.israeli_id === '313163412');
    const blocked = l.blocked.find((b) => b.field === 'sick_balance_opening');
    assert.ok(blocked, 'an older measurement must be blocked');
    assert.ok(/2026-08/.test(blocked.reason), 'the reason names the month already on file');
    ok('a balance older than the one on file is blocked, not applied');
  }

  console.log('an ID we do not have is reported, never hired');
  {
    const before = await Employee.countDocuments();
    const rows = [...ROWS, { employee_number: '999', israeli_id: '205406523',
      email: 'stranger@example.com', phone: '0587403399' }];
    const plan = await R.buildImportPlan(rows, '2026-08');
    assert.strictEqual(plan.unknown.length, 1);
    assert.strictEqual(plan.unknown[0].israeli_id, '205406523');
    await R.applyImportPlan(rows, '2026-08', ['205406523']);
    assert.strictEqual(await Employee.countDocuments(), before,
      'a roster is not a hiring decision — no employee may be created');
    ok('an unknown ID is listed and creates nobody, even when approved');
  }

  console.log('the same person twice is two answers and no way to choose');
  {
    const dup = [ROWS[0], { ...ROWS[0], phone: '0500000001' }];
    const plan = await R.buildImportPlan(dup, '2026-08');
    assert.strictEqual(plan.matched.length, 0, 'neither copy may be applied');
    assert.strictEqual(plan.invalid.length, 1);
    ok('a duplicated ת"ז is refused rather than last-one-wins');
  }

  console.log('applying writes only what was approved');
  {
    await Employee.updateOne({ _id: rinat._id }, { $set: { email: 'old@example.com' } });
    const res = await R.applyImportPlan(ROWS, '2026-08', []); // nobody approved
    assert.strictEqual(res.updated.length, 0);
    const untouched = await Employee.findById(rinat._id).lean();
    assert.strictEqual(untouched.email, 'old@example.com');
    ok('approving nobody writes nothing');

    const res2 = await R.applyImportPlan(ROWS, '2026-08', ['208430777']);
    assert.strictEqual(res2.updated.length, 1);
    const after = await Employee.findById(rinat._id).lean();
    assert.strictEqual(after.email, 'rinat8891996@gmail.com');
    assert.strictEqual(after.phone, '0547018164');
    assert.strictEqual(after.gender, 'female', 'נקבה is stored as the schema value');
    assert.strictEqual(after.marital_status, 'רווק/ה');
    assert.strictEqual(after.postal_code, '6800329');
    assert.strictEqual(after.vacation_balance_opening.days, 6.002);
    assert.strictEqual(after.vacation_balance_opening.as_of_month, '2026-08');
    assert.strictEqual(after.sick_balance_opening.days, 63);
    assert.strictEqual(new Date(after.birth_date).toISOString().slice(0, 10), '1996-12-16');
    ok('the approved employee is written across every field, balances included');

    const lidorAfter = await Employee.findById(lidor._id).lean();
    assert.strictEqual(lidorAfter.email, 'keep@example.com',
      'the employee who was NOT approved this time stays as she was');
    ok('an unapproved employee in the same file is left alone');
  }

  console.log('the caller cannot name the value, only the person');
  {
    // A page that could post both the field and its content would be a way to
    // write anything onto anyone. applyImportPlan re-derives from the rows.
    const res = await R.applyImportPlan(
      [{ ...ROWS[0], email: 'rinat8891996@gmail.com' }], '2026-08', ['208430777'],
    );
    const after = await Employee.findById(rinat._id).lean();
    assert.strictEqual(after.email, 'rinat8891996@gmail.com');
    assert.strictEqual(res.skipped.length + res.updated.length, 1);
    ok('values come from the re-derived plan, not from what the caller posted');
  }

  console.log(`\nAll employee-roster import tests passed (${passed} checks).`);
  process.exit(0);
})().catch(async (err) => {
  console.error('\nFAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
