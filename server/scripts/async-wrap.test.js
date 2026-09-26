#!/usr/bin/env node
/**
 * A rejected async handler must become next(err) — not a hung socket.
 *
 *   node scripts/async-wrap.test.js
 */
const { asyncWrap, wrapControllers } = require('../src/utils/asyncWrap');

let failures = 0;
const ok = (cond, label) => {
  console.log(`  ${cond ? '✅' : '❌'} ${label}`);
  if (!cond) failures++;
};

(async () => {
  console.log('\n🕳️ asyncWrap\n');

  // Rejected promise → next(err)
  let caught = null;
  await new Promise((r) => {
    asyncWrap(async () => { throw new Error('boom'); })({}, {}, (e) => { caught = e; r(); });
  });
  ok(caught && caught.message === 'boom', 'דחיית async מגיעה ל-next');

  // Synchronous throw → next(err)
  caught = null;
  asyncWrap(() => { throw new Error('sync'); })({}, {}, (e) => { caught = e; });
  ok(caught && caught.message === 'sync', 'זריקה סינכרונית מגיעה ל-next');

  // Success passes through untouched.
  let responded = false;
  await asyncWrap(async (req, res) => { res.done = true; responded = true; })({}, {}, () => {});
  ok(responded, 'הצלחה עוברת כרגיל');

  console.log('\n🕳️ wrapControllers\n');

  const mod = {
    handler: async () => { throw new Error('x'); },
    errorMiddleware: (err, req, res, next) => {},   // 4 args — must stay as-is
    CONSTANT: 42,
  };
  const wrapped = wrapControllers(mod);
  caught = null;
  await new Promise((r) => { wrapped.handler({}, {}, (e) => { caught = e; r(); }); });
  ok(caught && caught.message === 'x', 'handler עטוף');
  ok(wrapped.errorMiddleware === mod.errorMiddleware, 'error middleware (4 פרמטרים) לא נגעו בו');
  ok(wrapped.CONSTANT === 42, 'ייצוא שאינו פונקציה עובר כמו שהוא');
  ok(mod.handler !== wrapped.handler && typeof mod.handler === 'function',
    'המודול המקורי לא שונה (עותק)');

  console.log('');
  if (failures) { console.log(`❌ ${failures} נכשלו`); process.exit(1); }
  console.log('✅ הכל עבר');
})();
