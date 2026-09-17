/**
 * Deleting a contract issued by mistake, and refusing to delete one that is not.
 *
 * Three identical "נשלח לחתימה" rows a minute apart is a form submitted three
 * times, and leaving them there means nobody can tell which link the employee
 * actually holds. A signed contract is the opposite thing entirely: it is the
 * evidence that an employment agreement exists, and the whole point of an
 * electronic signature is that the document behind it cannot quietly stop
 * existing.
 *
 * So what is asserted here is mostly what the endpoint REFUSES, and that it
 * says why in a sentence the person can act on.
 *
 *   node scripts/contract-delete.test.js
 */
const assert = require('assert');
const mongoose = require('mongoose');

let failures = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures += 1; console.log(`  ✗ ${label} — ${e.message}`); }
}

/** A response object that records what the controller sent. */
function res() {
  const r = { code: 200, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

async function main() {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { dbName: 'contract-delete-test' });

  const { EmploymentContract, Employee, Branch } = require('../src/models');
  const ctrl = require('../src/controllers/employmentContracts.controller');

  const branch = await Branch.create({ name: 'כפר סבא - משה דיין' });
  const emp = await Employee.create({
    full_name: 'גלאם רות', branch_id: branch._id, position: 'סייעת', israeli_id: '011111118',
  });

  const admin = { user: { id: new mongoose.Types.ObjectId(), role: 'system_admin', full_name: 'מנהל' } };
  const manager = { user: { id: new mongoose.Types.ObjectId(), role: 'branch_manager', full_name: 'מנהלת סניף' } };

  const make = (status, extra = {}) => EmploymentContract.create({
    employee_id: emp._id, branch_id: branch._id, status, ...extra,
  });
  const del = async (req, id) => {
    const r = res();
    await ctrl.remove({ ...req, params: { id: String(id) } }, r, (e) => { throw e; });
    return r;
  };

  console.log('\nwhat may be deleted');

  await check('a draft nobody sent', async () => {
    const c = await make('draft');
    const r = await del(admin, c._id);
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    assert.strictEqual(await EmploymentContract.countDocuments({ _id: c._id }), 0);
  });

  await check('a contract sent for signature but never signed', async () => {
    const c = await make('sent', { sent_at: new Date(), access_token: 'tok-1' });
    const r = await del(admin, c._id);
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    assert.strictEqual(await EmploymentContract.countDocuments({ _id: c._id }), 0);
  });

  await check('deleting a sent one takes its signing link with it', async () => {
    const c = await make('sent', { sent_at: new Date(), access_token: 'tok-2' });
    await del(admin, c._id);
    // publicGet resolves the token against the row; with the row gone there is
    // nothing for a stale link to open.
    const stillThere = await EmploymentContract.findOne({ access_token: 'tok-2' });
    assert.strictEqual(stillThere, null);
  });

  console.log('\nwhat may not, and whether it says why');

  for (const [status, expect] of [
    ['signed', /חוזה חדש/],
    ['approved', /חוזה חדש/],
    ['uploaded', /חוזה חדש/],
    ['waived', /ויתור/],
  ]) {
    await check(`a ${status} contract is refused, with a reason`, async () => {
      const c = await make(status);
      const r = await del(admin, c._id);
      assert.strictEqual(r.code, 409, JSON.stringify(r.body));
      assert.ok(expect.test(r.body.error), r.body.error);
      assert.strictEqual(await EmploymentContract.countDocuments({ _id: c._id }), 1);
      await EmploymentContract.deleteOne({ _id: c._id });
    });
  }

  console.log('\nwho may');

  await check('a branch manager may not delete, even a draft she could create', async () => {
    const c = await make('draft');
    const r = await del(manager, c._id);
    assert.strictEqual(r.code, 403, JSON.stringify(r.body));
    assert.strictEqual(await EmploymentContract.countDocuments({ _id: c._id }), 1);
    await EmploymentContract.deleteOne({ _id: c._id });
  });

  await check('a contract that does not exist is a 404, not a crash', async () => {
    const r = await del(admin, new mongoose.Types.ObjectId());
    assert.strictEqual(r.code, 404);
  });

  console.log('\nthe list the mistake actually looked like');

  await check('three identical sends can all be removed, leaving the signed one', async () => {
    const sent = await Promise.all([make('sent'), make('sent'), make('sent')]);
    const signed = await make('signed', { signed_at: new Date() });
    for (const c of sent) assert.strictEqual((await del(admin, c._id)).code, 200);
    const left = await EmploymentContract.find({ employee_id: emp._id }).lean();
    assert.strictEqual(left.length, 1);
    assert.strictEqual(String(left[0]._id), String(signed._id));
  });

  await mongoose.disconnect();
  await mongo.stop();
  console.log(failures === 0 ? '\nOK\n' : `\n${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
