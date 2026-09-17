/**
 * The clock's own gating logic — disabled, no branches, outside gan hours,
 * dry vs write — and the failure-recording it owns.
 *
 * `runPass` (see sheet-sync/run.js) can fail two ways without ever calling its
 * own `saveShadow`: it can reject (e.g. `writeCells` throwing), or it can
 * resolve normally with `errors.length > 0` because `pairRows` refused the
 * roster's structure. Neither reaches `SheetSyncState.last_error` /
 * `last_run_at` on its own — this job is the only thing that does, and only
 * after the fact, without ever touching `shadow`. That is the one behaviour
 * this suite exists to pin down; everything else here is the tick's pure
 * scheduling, which needs no database or network to exercise.
 *
 *   node scripts/sheet-sync-job.test.js
 */
const assert = require('assert');
const { tick } = require('../src/services/sheetSyncJob');

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures += 1; console.log(`  ✗ ${label} — ${e.message}`); }
}

const scenarios = [];
function scenario(title, fn) { scenarios.push({ title, fn }); }

// Israel is UTC+3 in September (DST). These land at 02:00 (before opening),
// 10:00 (open, daytime pass) and 23:00 (nightly check) Israel time.
const BEFORE_OPEN = new Date('2026-09-16T23:00:00Z');
const OPEN_HOUR = new Date('2026-09-17T07:00:00Z');
const NIGHTLY = new Date('2026-09-17T20:00:00Z');

const oneBranch = [{ branch_id: 'b1', sheet_id: 's1' }];

function deps({ cfg, runPass, verifyDay } = {}) {
  const runPassCalls = [];
  const verifyDayCalls = [];
  const recordFailureCalls = [];
  return {
    runPassCalls, verifyDayCalls, recordFailureCalls,
    readSetting: async () => cfg || {},
    runPass: async (args) => {
      runPassCalls.push(args);
      return runPass ? runPass(args) : { date: args.date, children: 0, in: 0, out: 0, conflicts: 0, skipped: [], errors: [] };
    },
    verifyDay: async (args) => {
      verifyDayCalls.push(args);
      return verifyDay ? verifyDay(args) : { checked: 0, agreed: 0, disagreed: [], unresolved: [], unreadable: [] };
    },
    recordFailure: async (branchId, sheetId, date, message) => {
      recordFailureCalls.push({ branchId, sheetId, date, message });
    },
  };
}

scenario('disabled: nothing is read except the switch itself', async () => {
  const d = deps({ cfg: { enabled: false, branches: oneBranch } });
  const res = await tick(OPEN_HOUR, d);
  check('skipped as disabled', () => assert.deepStrictEqual(res, { skipped: 'disabled' }));
  check('runPass never called', () => assert.strictEqual(d.runPassCalls.length, 0));
  check('verifyDay never called', () => assert.strictEqual(d.verifyDayCalls.length, 0));
});

scenario('no config at all behaves like disabled', async () => {
  const d = deps({ cfg: {} });
  const res = await tick(OPEN_HOUR, d);
  check('skipped as disabled', () => assert.deepStrictEqual(res, { skipped: 'disabled' }));
});

scenario('enabled but no branches configured', async () => {
  const d = deps({ cfg: { enabled: true, branches: [] } });
  const res = await tick(OPEN_HOUR, d);
  check('skipped as no branches', () => assert.deepStrictEqual(res, { skipped: 'no branches' }));
});

scenario('outside gan hours and before the nightly check: branches are skipped, not attempted', async () => {
  const d = deps({ cfg: { enabled: true, branches: oneBranch } });
  const res = await tick(BEFORE_OPEN, d);
  check('nothing ran', () => assert.deepStrictEqual(res, { ran: [] }));
  check('runPass never called', () => assert.strictEqual(d.runPassCalls.length, 0));
  check('verifyDay never called', () => assert.strictEqual(d.verifyDayCalls.length, 0));
});

scenario('during gan hours with write:false, runPass is called in dry mode', async () => {
  const d = deps({ cfg: { enabled: true, write: false, branches: oneBranch } });
  await tick(OPEN_HOUR, d);
  check('called once', () => assert.strictEqual(d.runPassCalls.length, 1));
  check('mode is dry', () => assert.strictEqual(d.runPassCalls[0].mode, 'dry'));
  check('the nightly check does not run at 10:00', () => assert.strictEqual(d.verifyDayCalls.length, 0));
});

scenario('during gan hours with write:true, runPass is called in write mode', async () => {
  const d = deps({ cfg: { enabled: true, write: true, branches: oneBranch } });
  await tick(OPEN_HOUR, d);
  check('mode is write', () => assert.strictEqual(d.runPassCalls[0].mode, 'write'));
});

scenario('at the nightly hour, verifyDay runs and the daytime pass does not', async () => {
  const d = deps({ cfg: { enabled: true, branches: oneBranch } });
  await tick(NIGHTLY, d);
  check('verifyDay called once', () => assert.strictEqual(d.verifyDayCalls.length, 1));
  check('runPass not called at 23:00', () => assert.strictEqual(d.runPassCalls.length, 0));
});

scenario('a branch missing branch_id or sheet_id is skipped entirely', async () => {
  const d = deps({ cfg: { enabled: true, branches: [{ branch_id: 'b1' }, { sheet_id: 's2' }] } });
  const res = await tick(OPEN_HOUR, d);
  check('nothing ran', () => assert.deepStrictEqual(res, { ran: [] }));
});

// --- the two silent failure modes -----------------------------------------

scenario('runPass rejecting is recorded as a failure, and only that', async () => {
  const d = deps({
    cfg: { enabled: true, branches: oneBranch },
    runPass: async () => { throw new Error('the sheet refused the write'); },
  });
  const res = await tick(OPEN_HOUR, d);
  check('recordFailure called once', () => assert.strictEqual(d.recordFailureCalls.length, 1));
  check('with the branch, sheet, date and message', () => {
    const c = d.recordFailureCalls[0];
    assert.strictEqual(c.branchId, 'b1');
    assert.strictEqual(c.sheetId, 's1');
    assert.strictEqual(c.date, '2026-09-17');
    assert.strictEqual(c.message, 'the sheet refused the write');
  });
  check('the tick itself does not throw — it reports the branch as failed', () => {
    assert.strictEqual(res.ran[0].branch, 'b1');
    assert.strictEqual(res.ran[0].error, 'the sheet refused the write');
  });
});

scenario('runPass resolving with errors.length > 0 is recorded too, though nothing threw', () => {
  const d = deps({
    cfg: { enabled: true, branches: oneBranch },
    runPass: async () => ({
      date: '2026-09-17', children: 0, in: 0, out: 0, conflicts: 0, skipped: [],
      errors: [{ reason: 'the roster and today tabs do not line up' }],
    }),
  });
  return tick(OPEN_HOUR, d).then((res) => {
    check('recordFailure called once even though runPass resolved', () => assert.strictEqual(d.recordFailureCalls.length, 1));
    check('the message names the structural refusal', () => {
      assert.strictEqual(d.recordFailureCalls[0].message, 'the roster and today tabs do not line up');
    });
    check('the pass result (with its errors) still comes back in ran[]', () => {
      assert.strictEqual(res.ran[0].errors.length, 1);
    });
  });
});

scenario('a clean pass never calls recordFailure', async () => {
  const d = deps({
    cfg: { enabled: true, branches: oneBranch },
    runPass: async () => ({ date: '2026-09-17', children: 2, in: 1, out: 0, conflicts: 0, skipped: [], errors: [] }),
  });
  await tick(OPEN_HOUR, d);
  check('recordFailure never called', () => assert.strictEqual(d.recordFailureCalls.length, 0));
});

scenario('a nightly archive that will not parse is reported, not treated as agreement', async () => {
  const d = deps({
    cfg: { enabled: true, branches: oneBranch },
    verifyDay: async () => ({ error: 'archive JSON did not parse: Unexpected token' }),
  });
  const res = await tick(NIGHTLY, d);
  check('the verify result carries the error through', () => {
    assert.strictEqual(res.ran[0].verify.error, 'archive JSON did not parse: Unexpected token');
  });
  check('recordFailure is not involved — the nightly check is not a sync pass', () => {
    assert.strictEqual(d.recordFailureCalls.length, 0);
  });
});

(async () => {
  for (const s of scenarios) {
    console.log(`\n${s.title}`);
    // eslint-disable-next-line no-await-in-loop
    await s.fn();
  }
  console.log(failures === 0 ? '\nOK\n' : `\n${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
