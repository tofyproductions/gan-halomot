/**
 * One ת"ז, one card.
 *
 * Two people were entered a second time on the morning of 30.08.2026, each
 * with the surname and the given name the other way round and the same ת"ז.
 * For the next three weeks the clock punched one card while the payslips were
 * filed against the other, one employee's history sat in two records with a
 * payroll month on each, and the screen that answers "did she get her payslip"
 * answered about whichever card it was looking at.
 *
 * Both guards are tested here — the model hook, which is the net under every
 * path, and the controller's message, which is what a person actually reads.
 *
 *   node scripts/duplicate-israeli-id.test.js
 */
const assert = require('assert');
const mongoose = require('mongoose');

let failures = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures += 1; console.log(`  ✗ ${label} — ${e.message}`); }
}

/** The save must be refused, and the reason must name the other card. */
async function refused(fn, expectName) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  assert.ok(err, 'the save was allowed');
  assert.ok(String(err.message).includes(expectName),
    `the refusal does not name "${expectName}": ${err.message}`);
}

async function main() {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { dbName: 'dup-id-test' });

  const { Employee, Branch } = require('../src/models');
  const branch = await Branch.create({ name: 'כפר סבא - משה דיין' });
  const base = { branch_id: branch._id, position: 'סייעת' };

  console.log('\nthe model refuses a second card for one number');

  const first = await Employee.create({ ...base, full_name: 'כהן גאליה', israeli_id: '051429389' });
  await check('the first card is created', () => assert.ok(first._id));

  await check('a second card with the same number is refused, and names the first', () =>
    refused(() => Employee.create({ ...base, full_name: 'גאליה כהן', israeli_id: '051429389' }), 'כהן גאליה'));

  await check('the same number without its leading zero is the same number', () =>
    refused(() => Employee.create({ ...base, full_name: 'גאליה כהן', israeli_id: '51429389' }), 'כהן גאליה'));

  await check('punctuation does not make it a different number', () =>
    refused(() => Employee.create({ ...base, full_name: 'גאליה כהן', israeli_id: '05-142-9389' }), 'כהן גאליה'));

  console.log('\na retired card still holds its number');

  await Employee.updateOne({ _id: first._id }, { $set: { is_active: false } });
  await check('a card that is no longer active still blocks a new one', () =>
    refused(() => Employee.create({ ...base, full_name: 'גאליה כהן', israeli_id: '051429389' }), 'כהן גאליה'));
  await check('and the refusal says the card is not active', async () => {
    let err = null;
    try { await Employee.create({ ...base, full_name: 'גאליה כהן', israeli_id: '051429389' }); } catch (e) { err = e; }
    assert.ok(/לא פעילה/.test(err.message), err.message);
  });
  await Employee.updateOne({ _id: first._id }, { $set: { is_active: true } });

  console.log('\nwhat it does not refuse');

  await check('a different number is fine', async () => {
    const other = await Employee.create({ ...base, full_name: 'אסתר גוטליב', israeli_id: '022203921' });
    assert.ok(other._id);
  });

  await check('blank is exempt — most of the roster predates the field', async () => {
    const a = await Employee.create({ ...base, full_name: 'ללא תז א' });
    const b = await Employee.create({ ...base, full_name: 'ללא תז ב' });
    assert.ok(a._id && b._id);
  });

  await check('saving an unrelated field on an existing card is not refused', async () => {
    const e = await Employee.findById(first._id);
    e.phone = '0500000000';
    await e.save();
    assert.strictEqual((await Employee.findById(first._id).lean()).phone, '0500000000');
  });

  await check('a card may keep its own number', async () => {
    const e = await Employee.findById(first._id);
    e.israeli_id = '051429389';
    await e.save();
    assert.strictEqual((await Employee.findById(first._id).lean()).israeli_id, '051429389');
  });

  await check('editing a card onto somebody else\'s number is refused', async () => {
    const e = await Employee.findOne({ full_name: 'אסתר גוטליב' });
    e.israeli_id = '051429389';
    await refused(() => e.save(), 'כהן גאליה');
  });

  console.log('\nthe message the person at the screen reads');

  const payroll = require('../src/controllers/payroll.controller');
  // Exported for this suite: the wording is the whole point of the guard.
  const { duplicateIdMessage } = payroll;
  await check('an active card sends her to the existing one', () => {
    const m = duplicateIdMessage({
      israeli_id: '051429389', full_name: 'כהן גאליה', is_active: true, branch_name: 'כפר סבא - משה דיין',
    });
    assert.ok(m.includes('כהן גאליה'), m);
    assert.ok(m.includes('כפר סבא - משה דיין'), m);
    assert.ok(/לערוך את הכרטיס הקיים/.test(m), m);
  });
  await check('a retired card tells her to reopen it, and why', () => {
    const m = duplicateIdMessage({
      israeli_id: '051429389', full_name: 'כהן גאליה', is_active: false, branch_name: 'כפר סבא - משה דיין',
    });
    assert.ok(/להפעיל מחדש/.test(m), m);
    assert.ok(/ההחתמות והתלושים/.test(m), m);
  });
  await check('no branch on the card, no dangling preposition', () => {
    const m = duplicateIdMessage({ israeli_id: '1', full_name: 'פלונית', is_active: true, branch_name: '' });
    assert.ok(!m.includes('בסניף '), m);
  });

  await mongoose.disconnect();
  await mongo.stop();
  console.log(failures === 0 ? '\nOK\n' : `\n${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
