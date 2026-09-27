#!/usr/bin/env node
/**
 * The contract chain's new joints, tested without a database:
 *
 *   1. missingPersonalFields — a blank field in the frozen context is reported
 *      by its Hebrew label; a filled one is not.
 *   2. applyFills — the signer's completions land in the merge fields and are
 *      offered to the employee card ONLY where the card is empty; a value the
 *      manager already froze is never overwritten by the signer.
 *   3. render with employerSignature — the employer box carries the manager's
 *      stamped signature; without one it stays the ruled line it always was.
 *
 *   node scripts/contract-chain.test.js
 */

const assert = require('assert');
const { missingPersonalFields, applyFills } = require('../src/controllers/employmentContracts.controller');
const tpl = require('../src/services/employmentContract');

let passed = 0;
const ok = (name, fn) => { fn(); passed += 1; console.log(`  ✓ ${name}`); };

console.log('missingPersonalFields');
ok('empty context → every personal field is missing', () => {
  const missing = missingPersonalFields({});
  const keys = missing.map(m => m.key).sort();
  assert.deepStrictEqual(keys, ['address', 'bank', 'email', 'phone', 'religion']);
});
ok('filled context → nothing missing', () => {
  const missing = missingPersonalFields({
    address: 'רחוב', phone: '0501234567', email: 'a@b.c', religion: 'יהודית', bank_text: 'בנק 10',
  });
  assert.strictEqual(missing.length, 0);
});

console.log('applyFills');
const mkDoc = (fields) => ({ fields: { ...fields }, markModified: () => {} });

ok('fills complete only what is empty, and reach the empty card', () => {
  const doc = mkDoc({ address: '', phone: '050', email: '' });
  const emp = { address: '', phone: '050', email: '' };
  const upd = applyFills(doc, emp, { address: 'הרצל 1', email: 'x@y.z', phone: '999' });
  assert.strictEqual(doc.fields.address, 'הרצל 1');
  assert.strictEqual(doc.fields.email, 'x@y.z');
  // phone was already frozen by the manager — the signer cannot move it.
  assert.strictEqual(doc.fields.phone, '050');
  assert.deepStrictEqual(Object.keys(upd).sort(), ['address', 'email']);
});
ok('a card that already knows a value is not overwritten', () => {
  const doc = mkDoc({ address: '' });
  const emp = { address: 'כתובת קיימת' };
  const upd = applyFills(doc, emp, { address: 'כתובת חדשה' });
  assert.strictEqual(doc.fields.address, 'כתובת חדשה');   // the contract completes
  assert.strictEqual(upd.address, undefined);              // the card stays hers
});
ok('bank fills need number+branch+account to count, and build bank_text with the state name', () => {
  const doc = mkDoc({ bank_text: '' });
  const none = applyFills(doc, {}, { bank_number: '10' });
  assert.strictEqual(doc.fields.bank_text, '');
  assert.deepStrictEqual(none, {});
  const upd = applyFills(doc, { bank_number: '' }, {
    bank_number: '10', bank_name: 'בנק לאומי', bank_branch: '936', bank_account: '123456',
  });
  assert.ok(doc.fields.bank_text.includes('בנק לאומי (10)'));
  assert.ok(doc.fields.bank_text.includes('סניף 936'));
  assert.strictEqual(upd.bank_number, '10');
});
ok('missing → filled: the two functions close the loop', () => {
  const doc = mkDoc({ address: '', phone: '1', email: 'a@b.c', religion: '', bank_text: 'בנק 10' });
  applyFills(doc, {}, { address: 'רחוב', religion: 'יהודית' });
  assert.strictEqual(missingPersonalFields(doc.fields).length, 0);
});

console.log('render with employerSignature');
const ctx = tpl.buildContext({ full_name: 'בדיקה', salary_type: 'hourly' }, {});
ok('no employer signature → the ruled employer line', () => {
  const html = tpl.render(ctx);
  assert.ok(html.includes('המעסיק — גן החלומות ע.ר'));
  assert.ok(!html.includes('חתימת המעסיק'));
});
ok('employer signature → stamped image, name and date', () => {
  const html = tpl.render(ctx, {
    employerSignature: { data_url: 'data:image/png;base64,AAA', signer_name: 'לינוי', signed_at: new Date('2026-09-27') },
  });
  assert.ok(html.includes('חתימת המעסיק'));
  assert.ok(html.includes('באמצעות לינוי'));
});
ok('both signatures render side by side', () => {
  const html = tpl.render(ctx, {
    signature: { data_url: 'data:image/png;base64,BBB', signer_name: 'עובדת', signed_at: new Date() },
    employerSignature: { data_url: 'data:image/png;base64,AAA', signer_name: 'לינוי', signed_at: new Date() },
  });
  assert.ok(html.includes('חתימת העובדת'));
  assert.ok(html.includes('חתימת המעסיק'));
});

console.log(`\nAll contract-chain tests passed (${passed} checks).`);
