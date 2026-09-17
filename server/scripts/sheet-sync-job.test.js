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
const { tick, describeTick, resetAnnouncements } = require('../src/services/sheetSyncJob');

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
  const markNightlyRanCalls = [];
  // A plain Map standing in for the Setting document: persists across
  // several `tick()` calls made with the SAME `d`, exactly like the real
  // Setting persists across ticks in production, so a test can call tick()
  // twice and see the second call behave as "already ran tonight".
  const nightlyRanStore = new Map();
  return {
    runPassCalls, verifyDayCalls, recordFailureCalls, markNightlyRanCalls, nightlyRanStore,
    readSetting: async () => cfg || {},
    runPass: async (args) => {
      runPassCalls.push(args);
      return runPass ? runPass(args) : { date: args.date, children: 0, in: 0, out: 0, conflicts: 0, skipped: [], errors: [] };
    },
    verifyDay: async (args) => {
      verifyDayCalls.push(args);
      // The default is a completed audit: the archive row existed AND it
      // compared somebody. Both halves matter — a row that named nobody is
      // not an audit, however clean its counters look. Scenarios exercising
      // the "archive not written yet" race, the empty row, or a failing
      // check pass their own verifyDay stub.
      return verifyDay
        ? verifyDay(args)
        : { checked: 2, agreed: 2, disagreed: [], unresolved: [], unreadable: [], archive_found: true, entries: 2 };
    },
    recordFailure: async (branchId, sheetId, date, message) => {
      recordFailureCalls.push({ branchId, sheetId, date, message });
    },
    readNightlyRan: async (branchId) => nightlyRanStore.get(branchId) || null,
    markNightlyRan: async (branchId, date) => {
      markNightlyRanCalls.push({ branchId, date });
      nightlyRanStore.set(branchId, date);
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
  check('skipped as no branches, and said out loud', () => {
    assert.deepStrictEqual(res, { skipped: 'no branches', announce: true });
  });
  check('it reaches the log as an error, not as silence', () => {
    const lines = describeTick(res);
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0].level, 'error');
  });
  const again = await tick(OPEN_HOUR, d);
  check('the next tick two minutes later carries the state without repeating the line', () => {
    assert.strictEqual(again.skipped, 'no branches');
    assert.strictEqual(again.announce, false);
    assert.deepStrictEqual(describeTick(again), []);
  });
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

// --- fix round 4: the rollout is per branch, so the switch has to be -------

scenario('a branch that has not opted in stays dry, however the global switch is set', async () => {
  const d = deps({ cfg: { enabled: true, write: true, branches: oneBranch } });
  await tick(OPEN_HOUR, d);
  check('mode is dry — write-back is never inherited', () => {
    assert.strictEqual(d.runPassCalls[0].mode, 'dry');
  });
});

scenario('a branch that opted in writes', async () => {
  const d = deps({ cfg: { enabled: true, write: true, branches: [{ branch_id: 'b1', sheet_id: 's1', write: true }] } });
  await tick(OPEN_HOUR, d);
  check('mode is write', () => assert.strictEqual(d.runPassCalls[0].mode, 'write'));
});

scenario('one branch writing does not make the next one write', async () => {
  // The whole of the rollout plan: משה דיין has earned its clean night and
  // writes; קפלן has just been added and must run read-only until it earns
  // its own, while still syncing inwards and still being audited every night.
  const d = deps({
    cfg: {
      enabled: true,
      branches: [
        { branch_id: 'b1', sheet_id: 's1', write: true },
        { branch_id: 'b2', sheet_id: 's2' },
      ],
    },
  });
  await tick(OPEN_HOUR, d);
  check('the first branch writes', () => assert.strictEqual(d.runPassCalls[0].mode, 'write'));
  check('the second is dry', () => assert.strictEqual(d.runPassCalls[1].mode, 'dry'));
  check('but it is still synced and still audited', () => {
    assert.strictEqual(d.runPassCalls.length, 2);
  });
});

scenario('the global switch still works as a master off', async () => {
  const d = deps({
    cfg: { enabled: true, write: false, branches: [{ branch_id: 'b1', sheet_id: 's1', write: true }] },
  });
  await tick(OPEN_HOUR, d);
  check('one edit stops a branch that had opted in', () => {
    assert.strictEqual(d.runPassCalls[0].mode, 'dry');
  });
});

scenario('at the nightly hour, verifyDay runs and the daytime pass does not', async () => {
  const d = deps({ cfg: { enabled: true, branches: oneBranch } });
  await tick(NIGHTLY, d);
  check('verifyDay called once', () => assert.strictEqual(d.verifyDayCalls.length, 1));
  check('runPass not called at 23:00', () => assert.strictEqual(d.runPassCalls.length, 0));
});

scenario('a branch missing branch_id or sheet_id is reported, not passed over', async () => {
  // The Setting is hand-edited in the database without a deploy, so `branchId`
  // for `branch_id` is one keystroke away — and a branch that never syncs and
  // never audits is indistinguishable from a working one unless somebody says
  // so.
  const d = deps({ cfg: { enabled: true, branches: [{ branch_id: 'b1' }, { sheet_id: 's2' }] } });
  const res = await tick(OPEN_HOUR, d);
  check('neither entry was run', () => assert.strictEqual(d.runPassCalls.length, 0));
  check('both are reported with the key they are missing', () => {
    assert.deepStrictEqual(res.ran.map(x => x.misconfigured), [['sheet_id'], ['branch_id']]);
  });
  check('and the report names which entry in the setting', () => {
    assert.deepStrictEqual(res.ran.map(x => x.entry), [0, 1]);
  });
  check('it reaches the log', () => {
    const lines = describeTick(res);
    assert.strictEqual(lines.length, 2);
    assert.ok(lines.every(l => l.level === 'error'));
    assert.ok(/branches\[0\].*sheet_id/.test(lines[0].text));
  });
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
  // pairRows (roster.js) reports its refusals as plain strings, e.g.
  // "סדר יום has 3 rows, needs 5 for 4 children" — not error objects — so the
  // fake here matches that real shape rather than an invented one.
  const d = deps({
    cfg: { enabled: true, branches: oneBranch },
    runPass: async () => ({
      date: '2026-09-17', children: 0, in: 0, out: 0, conflicts: 0, skipped: [],
      errors: ['סדר יום has 3 rows, needs 5 for 4 children'],
    }),
  });
  return tick(OPEN_HOUR, d).then((res) => {
    check('recordFailure called once even though runPass resolved', () => assert.strictEqual(d.recordFailureCalls.length, 1));
    check('the message names the structural refusal', () => {
      assert.strictEqual(d.recordFailureCalls[0].message, 'סדר יום has 3 rows, needs 5 for 4 children');
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
    // A row that will not parse still proves a row exists (see nightly.js) —
    // archive_found stays true here.
    verifyDay: async () => ({ error: 'archive JSON did not parse: Unexpected token', archive_found: true }),
  });
  const res = await tick(NIGHTLY, d);
  check('it is reported under its own key, never under verify', () => {
    assert.strictEqual(res.ran[0].auditUnparsable, 'archive JSON did not parse: Unexpected token');
    assert.strictEqual(res.ran[0].verify, undefined);
  });
  check('and the night is not spent — a row that cannot be read compared nobody', () => {
    assert.strictEqual(d.markNightlyRanCalls.length, 0);
  });
  check('recordFailure is not involved — the nightly check is not a sync pass', () => {
    assert.strictEqual(d.recordFailureCalls.length, 0);
  });
});

// --- fix round 1: the nightly check must run once, and must not masquerade
//     as a sync failure --------------------------------------------------

scenario('the nightly check runs once per branch per date, however many ticks land inside the hour', async () => {
  const d = deps({ cfg: { enabled: true, branches: oneBranch } });
  await tick(NIGHTLY, d);
  await tick(NIGHTLY, d);
  await tick(NIGHTLY, d);
  check('verifyDay fetched the archive only once, not once per tick', () => {
    assert.strictEqual(d.verifyDayCalls.length, 1);
  });
  check('the "done for tonight" marker was written once', () => {
    assert.strictEqual(d.markNightlyRanCalls.length, 1);
    assert.deepStrictEqual(d.markNightlyRanCalls[0], { branchId: 'b1', date: '2026-09-17' });
  });
});

scenario('a new date is a fresh check, even for the same branch', async () => {
  const d = deps({ cfg: { enabled: true, branches: oneBranch } });
  await tick(NIGHTLY, d); // 2026-09-17
  await tick(new Date('2026-09-18T20:00:00Z'), d); // 2026-09-18, 23:00 Israel time
  check('verifyDay ran once per night, twice total', () => assert.strictEqual(d.verifyDayCalls.length, 2));
});

scenario('a nightly audit that throws is the audit failing, not the sync — recordFailure is never called', async () => {
  const d = deps({
    cfg: { enabled: true, branches: oneBranch },
    verifyDay: async () => { throw new Error('Sheets API timed out'); },
  });
  const res = await tick(NIGHTLY, d);
  check('recordFailure was never called', () => assert.strictEqual(d.recordFailureCalls.length, 0));
  check('the branch result carries an auditError, not error (that key means the sync pass failed)', () => {
    assert.strictEqual(res.ran[0].auditError, 'Sheets API timed out');
    assert.strictEqual(res.ran[0].error, undefined);
  });
  check('a failed audit attempt is not marked done — it must be retried, not skipped for the rest of the night', () => {
    assert.strictEqual(d.markNightlyRanCalls.length, 0);
  });
});

scenario('a transient audit failure is retried on the next tick within the same hour, and then marked done', async () => {
  let calls = 0;
  const d = deps({
    cfg: { enabled: true, branches: oneBranch },
    verifyDay: async () => {
      calls += 1;
      if (calls === 1) throw new Error('Sheets API timed out');
      return { checked: 1, agreed: 1, disagreed: [], unresolved: [], unreadable: [], archive_found: true };
    },
  });
  const first = await tick(NIGHTLY, d);
  const second = await tick(NIGHTLY, d);
  const third = await tick(NIGHTLY, d);
  check('the first tick sees the audit failure', () => assert.strictEqual(first.ran[0].auditError, 'Sheets API timed out'));
  check('the second tick retries and succeeds', () => assert.ok(second.ran[0].verify));
  check('the third tick is skipped — already done for tonight', () => assert.strictEqual(third.ran.length, 0));
  check('verifyDay was called exactly twice (the failure, then the success)', () => {
    assert.strictEqual(d.verifyDayCalls.length, 2);
  });
});

scenario('a day-pass failure earlier in the day and a nightly audit failure later are recorded independently', async () => {
  const d = deps({
    cfg: { enabled: true, branches: oneBranch },
    runPass: async () => { throw new Error('the sheet refused the write'); },
    verifyDay: async () => { throw new Error('Sheets API timed out'); },
  });
  await tick(OPEN_HOUR, d);
  check('the day pass failure was recorded', () => assert.strictEqual(d.recordFailureCalls.length, 1));
  await tick(NIGHTLY, d);
  check('the nightly audit failure did NOT add a second recordFailure call', () => {
    assert.strictEqual(d.recordFailureCalls.length, 1);
  });
  check('the one recordFailure call on record is still the day pass\'s, untouched by the audit', () => {
    assert.strictEqual(d.recordFailureCalls[0].message, 'the sheet refused the write');
  });
});

// --- fix round 2: an absent archive must never read as a clean audit ------
//
// The archive job's real write times run 23:28-23:37; NIGHTLY_HOUR is 23, so
// the first tick or two of the hour will always find no row yet. verifyDay
// signals that with archive_found: false rather than throwing, and it is
// byte-identical in every OTHER field to a real, fully-audited, zero-
// disagreement night. These scenarios pin that the job never marks that
// night done, and never presents it as a completed audit.

scenario('an absent archive is not marked done, and does not look like a clean audit', async () => {
  const d = deps({
    cfg: { enabled: true, branches: oneBranch },
    verifyDay: async () => ({ checked: 0, agreed: 0, disagreed: [], unresolved: [], unreadable: [], archive_found: false }),
  });
  const res = await tick(NIGHTLY, d);
  check('nothing is marked done for tonight', () => assert.strictEqual(d.markNightlyRanCalls.length, 0));
  check('the branch result is pushed under its own key, never under "verify"', () => {
    assert.strictEqual(res.ran[0].auditPending, true);
    assert.strictEqual(res.ran[0].verify, undefined);
  });
});

scenario('the archive appearing on a later tick within the same hour is the audit that actually counts', async () => {
  let calls = 0;
  const d = deps({
    cfg: { enabled: true, branches: oneBranch },
    verifyDay: async () => {
      calls += 1;
      // 23:00 and 23:02: not written yet. 23:04 onward: the archive job has
      // finally run.
      if (calls <= 2) return { checked: 0, agreed: 0, disagreed: [], unresolved: [], unreadable: [], archive_found: false };
      return { checked: 3, agreed: 3, disagreed: [], unresolved: [], unreadable: [], archive_found: true };
    },
  });
  const first = await tick(NIGHTLY, d);
  check('the first tick finds nothing and marks nothing done', () => {
    assert.strictEqual(first.ran[0].auditPending, true);
    assert.strictEqual(d.markNightlyRanCalls.length, 0);
  });
  const second = await tick(NIGHTLY, d);
  check('the second tick still finds nothing and still marks nothing done', () => {
    assert.strictEqual(second.ran[0].auditPending, true);
    assert.strictEqual(d.markNightlyRanCalls.length, 0);
  });
  const third = await tick(NIGHTLY, d);
  check('the third tick finds the real archive and it is reported as an actual audit', () => {
    assert.ok(third.ran[0].verify);
    assert.strictEqual(third.ran[0].verify.checked, 3);
  });
  check('only now is tonight marked done', () => {
    assert.strictEqual(d.markNightlyRanCalls.length, 1);
  });
  const fourth = await tick(NIGHTLY, d);
  check('the fourth tick is skipped entirely — already done', () => {
    assert.strictEqual(fourth.ran.length, 0);
  });
  check('verifyDay was called exactly three times — the two misses, then the one real audit', () => {
    assert.strictEqual(d.verifyDayCalls.length, 3);
  });
});

// --- fix round 3: a row with nobody in it is not an audit either ----------
//
// The second door into the same failure. `archive_found` closed "there is no
// row yet"; this is "there is a row and it lists nobody" — the gan closed on
// a Saturday, the archive job fired over an empty board. Every field the job
// reads is byte-identical to a fully-audited clean night, so without a check
// on whether anything was actually COMPARED, the night is marked done, the
// tick prints nothing, and the operator reads that silence as the all-clear
// for switching write-back on.

scenario('an archive row that compared nobody is not a completed audit', async () => {
  const d = deps({
    cfg: { enabled: true, branches: oneBranch },
    verifyDay: async () => ({
      checked: 0, agreed: 0, disagreed: [], unresolved: [], unreadable: [],
      archive_found: true, entries: 0,
    }),
  });
  const res = await tick(NIGHTLY, d);
  check('the night is NOT marked done — nothing was compared', () => {
    assert.strictEqual(d.markNightlyRanCalls.length, 0);
  });
  check('nothing is pushed under verify, which means "compared and clean"', () => {
    assert.strictEqual(res.ran[0].verify, undefined);
  });
  check('it is reported as its own state, beside auditPending', () => {
    assert.strictEqual(res.ran[0].auditEmpty, true);
  });
});

scenario('a night that compared nobody is still open — a later tick can still audit it', async () => {
  let calls = 0;
  const d = deps({
    cfg: { enabled: true, branches: oneBranch },
    verifyDay: async () => {
      calls += 1;
      // 23:00 the board was empty; by 23:35 the archive job has written the
      // real row. A night consumed by the empty one never gets here.
      if (calls === 1) {
        return { checked: 0, agreed: 0, disagreed: [], unresolved: [], unreadable: [], archive_found: true, entries: 0 };
      }
      return { checked: 4, agreed: 4, disagreed: [], unresolved: [], unreadable: [], archive_found: true, entries: 4 };
    },
  });
  const first = await tick(NIGHTLY, d);
  check('the first tick compares nobody and consumes nothing', () => {
    assert.strictEqual(first.ran[0].auditEmpty, true);
    assert.strictEqual(d.markNightlyRanCalls.length, 0);
  });
  const second = await tick(NIGHTLY, d);
  check('the second tick is the audit that actually counts', () => {
    assert.strictEqual(second.ran[0].verify.checked, 4);
    assert.strictEqual(d.markNightlyRanCalls.length, 1);
  });
});

// --- fix round 5: a night that never happened must not be counted ---------
//
// The audit for date D can only run between 23:00 and 23:59 on D, and the
// archive it needs lands at 23:28-23:37 — about twenty minutes of margin. A
// deploy, a restart, or an archive written at 00:05 costs D its only chance,
// and until now nothing recorded that D was skipped, so an operator counting
// clean nights counted nights that did not happen.

scenario('a night nobody audited is reached back for, once', async () => {
  const d = deps({ cfg: { enabled: true, branches: oneBranch } });
  d.nightlyRanStore.set('b1', '2026-09-15'); // the 16th was never audited
  const res = await tick(NIGHTLY, d);

  check('both nights are audited, oldest first', () => {
    assert.deepStrictEqual(d.verifyDayCalls.map(c => c.date), ['2026-09-16', '2026-09-17']);
  });
  check('and both are marked done', () => {
    assert.deepStrictEqual(d.markNightlyRanCalls.map(c => c.date), ['2026-09-16', '2026-09-17']);
  });
  check('each night is reported under its own date', () => {
    assert.deepStrictEqual(res.ran.map(x => x.date), ['2026-09-16', '2026-09-17']);
  });

  const again = await tick(NIGHTLY, d);
  check('the next tick reaches back for nothing — tonight is done too', () => {
    assert.strictEqual(d.verifyDayCalls.length, 2);
    assert.deepStrictEqual(again.ran, []);
  });
});

scenario('the reach back is one night, and it is attempted once however many ticks', async () => {
  const d = deps({
    cfg: { enabled: true, branches: oneBranch },
    // Last night's archive row is gone; tonight's has not landed yet.
    verifyDay: async () => ({ checked: 0, agreed: 0, disagreed: [], unresolved: [], unreadable: [], archive_found: false }),
  });
  d.nightlyRanStore.set('b1', '2026-09-15');
  await tick(NIGHTLY, d);
  await tick(NIGHTLY, d);
  await tick(NIGHTLY, d);
  check('last night was tried once, tonight on every tick', () => {
    assert.deepStrictEqual(d.verifyDayCalls.map(c => c.date), [
      '2026-09-16', '2026-09-17', '2026-09-17', '2026-09-17',
    ]);
  });
  check('and nothing was marked done', () => assert.strictEqual(d.markNightlyRanCalls.length, 0));
});

scenario('nights older than the one reached back for are named, not audited', async () => {
  const d = deps({ cfg: { enabled: true, branches: oneBranch } });
  d.nightlyRanStore.set('b1', '2026-09-12'); // the 13th, 14th and 15th are gone
  const res = await tick(NIGHTLY, d);

  check('only the one night back and tonight are fetched', () => {
    assert.deepStrictEqual(d.verifyDayCalls.map(c => c.date), ['2026-09-16', '2026-09-17']);
  });
  check('the nights in between are reported as never audited', () => {
    const m = res.ran.find(x => x.missedNights);
    assert.ok(m, 'expected the gap to be reported');
    assert.deepStrictEqual(m.missedNights, { from: '2026-09-13', to: '2026-09-15' });
  });
  check('and it says so in the log', () => {
    const text = describeTick(res).map(l => l.text).join('\n');
    assert.ok(/2026-09-13 to 2026-09-15/.test(text), text);
    assert.ok(/never audited/.test(text));
  });
});

scenario('an unbroken run of audited nights reports no gap at all', async () => {
  const d = deps({ cfg: { enabled: true, branches: oneBranch } });
  d.nightlyRanStore.set('b1', '2026-09-16');
  const res = await tick(NIGHTLY, d);
  check('only tonight is audited', () => {
    assert.deepStrictEqual(d.verifyDayCalls.map(c => c.date), ['2026-09-17']);
  });
  check('nothing is reported as missed', () => {
    assert.ok(!res.ran.some(x => x.missedNights));
  });
});

scenario('a branch that has never audited anything does not reach into a past it was not running for', async () => {
  const d = deps({ cfg: { enabled: true, branches: oneBranch } });
  const res = await tick(NIGHTLY, d);
  check('only tonight', () => {
    assert.deepStrictEqual(d.verifyDayCalls.map(c => c.date), ['2026-09-17']);
  });
  check('and no gap is invented out of a missing marker', () => {
    assert.ok(!res.ran.some(x => x.missedNights));
  });
});

// --- fix round 6: a clean pass and a clean night have to say so ------------
//
// The spec promises a full log, and the rollout gate is a person reading a
// read-only day and then a night with zero disagreements. An empty log was
// what a working sync, a disabled one, a misconfigured branch, a crashed
// interval and an audit that compared nobody all produced.

scenario('a clean pass says what it did', async () => {
  const d = deps({
    cfg: { enabled: true, branches: oneBranch },
    runPass: async () => ({
      date: '2026-09-17', children: 12, in: 3, out: 0, conflicts: 0,
      skipped: [{ kind: 'row', access_id: 'id-9', name: 'ילד עזב', why: 'no single Child carries this sheet_access_id' }],
      errors: [],
    }),
  });
  const lines = describeTick(await tick(OPEN_HOUR, d));
  check('one line', () => assert.strictEqual(lines.length, 1));
  check('at log level, not error — an ordinary day is not a problem', () => {
    assert.strictEqual(lines[0].level, 'log');
  });
  check('carrying the counts a person needs, and the mode they are in', () => {
    assert.ok(/12 children/.test(lines[0].text), lines[0].text);
    assert.ok(/3 in/.test(lines[0].text));
    assert.ok(/1 skipped/.test(lines[0].text));
    assert.ok(/\(dry\)/.test(lines[0].text));
  });
});

scenario('a clean night says how many children it compared', async () => {
  const d = deps({ cfg: { enabled: true, branches: oneBranch } });
  const lines = describeTick(await tick(NIGHTLY, d));
  check('one line', () => assert.strictEqual(lines.length, 1));
  check('and it names the number compared, not merely the absence of alarm', () => {
    assert.ok(/compared 2 children/.test(lines[0].text), lines[0].text);
  });
});

scenario('a night that compared nobody is loud, and a night still waiting is quiet', async () => {
  const empty = deps({
    cfg: { enabled: true, branches: oneBranch },
    verifyDay: async () => ({ checked: 0, agreed: 0, disagreed: [], unresolved: [], unreadable: [], archive_found: true, entries: 0 }),
  });
  const emptyLines = describeTick(await tick(NIGHTLY, empty));
  check('the empty archive is an error line saying the night is not audited', () => {
    assert.strictEqual(emptyLines.length, 1);
    assert.strictEqual(emptyLines[0].level, 'error');
    assert.ok(/NOT audited/.test(emptyLines[0].text), emptyLines[0].text);
  });

  resetAnnouncements();
  const pending = deps({
    cfg: { enabled: true, branches: oneBranch },
    verifyDay: async () => ({ checked: 0, agreed: 0, disagreed: [], unresolved: [], unreadable: [], archive_found: false }),
  });
  check('an archive that has simply not landed yet prints nothing', async () => {
    assert.deepStrictEqual(describeTick(await tick(NIGHTLY, pending)), []);
  });
});

scenario('disabled prints nothing at all — silence means one thing', async () => {
  const d = deps({ cfg: { enabled: false, branches: oneBranch } });
  check('no lines', async () => assert.deepStrictEqual(describeTick(await tick(OPEN_HOUR, d)), []));
});

scenario('unreadable archive cells are reported, distinctly from a disagreement', async () => {
  const d = deps({
    cfg: { enabled: true, branches: oneBranch },
    verifyDay: async () => ({
      checked: 3, agreed: 3, disagreed: [], unresolved: [],
      unreadable: [{ access_id: 'id-1', name: 'נויה חגי', field: 'home.wake_time', why: 'unreadable' }],
      archive_found: true, entries: 3,
    }),
  });
  const lines = describeTick(await tick(NIGHTLY, d));
  check('the data-quality signal is not dropped on the floor', () => {
    assert.ok(lines.some(l => /could not be read/.test(l.text)), JSON.stringify(lines));
  });
  check('and it is not filed as an alarm — a garbled cell is not a pairing slip', () => {
    const line = lines.find(l => /could not be read/.test(l.text));
    assert.strictEqual(line.level, 'log');
  });
  check('nothing claims a disagreement', () => {
    assert.ok(!lines.some(l => /disagreements/.test(l.text)));
  });
});

scenario('disagreements are named in the error stream', async () => {
  const d = deps({
    cfg: { enabled: true, branches: oneBranch },
    verifyDay: async () => ({
      checked: 2, agreed: 1,
      disagreed: [{ access_id: 'id-1', name: 'נויה חגי', field: 'home.wake_time', archive: '06:15', ours: '' }],
      unresolved: [], unreadable: [], archive_found: true, entries: 2,
    }),
  });
  const lines = describeTick(await tick(NIGHTLY, d));
  check('the child is named', () => {
    assert.ok(lines.some(l => l.level === 'error' && /נויה חגי/.test(l.text)), JSON.stringify(lines));
  });
  check('and the night is still marked done — it was a real audit', () => {
    assert.strictEqual(d.markNightlyRanCalls.length, 1);
  });
});

(async () => {
  for (const s of scenarios) {
    console.log(`\n${s.title}`);
    // Announcements are remembered per day so a condition lasting an evening
    // prints once. That memory is module-level and would otherwise leak from
    // one scenario into the next, which all share a date.
    resetAnnouncements();
    // eslint-disable-next-line no-await-in-loop
    await s.fn();
  }
  console.log(failures === 0 ? '\nOK\n' : `\n${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
