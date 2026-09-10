/**
 * What a debt document says on the way out, and what a deleted one says.
 *
 * Two facts worth a test and no database.
 *
 * The storage KEY must never leave the server: it is a stable, guessable-ish
 * string that names an object in a private bucket, and everything a screen
 * needs is the id, the name and the size.
 *
 * A soft-deleted document must be invisible to every screen. Its week of grace
 * exists for the administrators who got it by email, not for anybody still
 * looking at the חייבים table — and "still listed but marked deleted" is
 * exactly the state that would leak it back to a parent.
 *
 *   node scripts/debt-documents.test.js
 */

const assert = require('assert');
const { documentOut, liveDocuments } = require('../src/controllers/debtDocuments.controller');

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures += 1;
    console.log(`  ✗ ${label} — ${err.message}`);
  }
}

const doc = {
  _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  key: 'debt-docs/branch/2026-2027/deadbeef.pdf',
  file_name: 'הסכם החזר חוב.pdf',
  content_type: 'application/pdf',
  bytes: 240000,
  visible_to_parent: true,
  uploaded_by_name: 'עינת',
  uploaded_at: new Date('2026-09-10T09:00:00Z'),
};

console.log('\ndocumentOut');
check('carries what a screen needs', () => {
  const out = documentOut(doc);
  assert.strictEqual(out.id, 'aaaaaaaaaaaaaaaaaaaaaaaa');
  assert.strictEqual(out.file_name, 'הסכם החזר חוב.pdf');
  assert.strictEqual(out.bytes, 240000);
  assert.strictEqual(out.visible_to_parent, true);
  assert.strictEqual(out.uploaded_by_name, 'עינת');
});
check('NEVER carries the storage key', () => {
  assert.ok(!('key' in documentOut(doc)), 'the key reached the client');
});
check('visible_to_parent is a real boolean, not whatever was stored', () => {
  assert.strictEqual(documentOut({ ...doc, visible_to_parent: undefined }).visible_to_parent, false);
});

console.log('\nliveDocuments');
check('a soft-deleted document is not listed', () => {
  const decision = {
    documents: [
      doc,
      { ...doc, _id: 'bbbbbbbbbbbbbbbbbbbbbbbb', deleted_at: new Date() },
    ],
  };
  const live = liveDocuments(decision);
  assert.strictEqual(live.length, 1);
  assert.strictEqual(String(live[0]._id), 'aaaaaaaaaaaaaaaaaaaaaaaa');
});
check('no decision at all is an empty list, not a crash', () => {
  assert.deepStrictEqual(liveDocuments(null), []);
  assert.deepStrictEqual(liveDocuments({}), []);
});

console.log(failures === 0 ? '\nOK\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
