/**
 * The archive check.
 *
 * All day the sync pairs rows to children by position, and a positional
 * scheme has no way to notice that it slipped. The nightly archive carries
 * accessId per child, so comparing it to what the day recorded is the only
 * alarm this design has.
 *
 *   node scripts/sheet-sync-nightly.test.js
 */
const assert = require('assert');
const { verifyDay } = require('../src/services/sheet-sync/nightly');

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures += 1; console.log(`  ✗ ${label} — ${e.message}`); }
}

const archiveRow = (date, children, timestamp = `${date} | 23:35`) => [date, JSON.stringify({ children }), timestamp];
const kid = (accessId, name, data) => ({ name, accessId, data });

// `child_name` is the field that exists on `Child` — there is no `full_name`
// — so a fake here that used `full_name` would let a wrong field name in
// `nightly.js` pass silently, exactly the bug this plan has already shipped
// twice.
function deps({ history, logs, children }) {
  const byAccess = children || new Map([
    ['id-1', { _id: 'c1', child_name: 'נויה חגי' }],
    ['id-2', { _id: 'c2', child_name: 'ליה לוין' }],
  ]);
  return {
    readGrids: async () => ({ children: [], today: [], history: [['Date', 'JSON_Data', 'Timestamp'], ...history] }),
    childrenByAccessId: async () => byAccess,
    loadLogs: async () => logs,
  };
}

const scenarios = [];
function scenario(title, fn) { scenarios.push({ title, fn }); }

scenario('agreement is the proof the pairing held', async () => {
  const res = await verifyDay({
    branchId: 'b1', sheetId: 's1', date: '2026-09-17',
    deps: deps({
      history: [archiveRow('2026-09-17', [kid('id-1', 'נויה חגי', { 'התעורר בבית': '06:15' })])],
      logs: new Map([['c1', { home: { wake_time: '06:15' }, meals: {}, sleep: {}, missing: [] }]]),
    }),
  });
  check('one child checked', () => assert.strictEqual(res.checked, 1));
  check('one agreed', () => assert.strictEqual(res.agreed, 1));
  check('nothing disagreed', () => assert.deepStrictEqual(res.disagreed, []));
  check('the archive row was actually found — this is a real audit, not a vacuous one', () => {
    assert.strictEqual(res.archive_found, true);
  });
});

scenario('a slipped pairing shows up as a named disagreement', async () => {
  const res = await verifyDay({
    branchId: 'b1', sheetId: 's1', date: '2026-09-17',
    deps: deps({
      history: [archiveRow('2026-09-17', [
        kid('id-1', 'נויה חגי', { 'התעורר בבית': '06:15' }),
        kid('id-2', 'ליה לוין', { 'התעורר בבית': '' }),
      ])],
      // נויה's morning ended up on ליה — exactly what a one-row slip looks like.
      logs: new Map([
        ['c1', { home: { wake_time: '' }, meals: {}, sleep: {}, missing: [] }],
        ['c2', { home: { wake_time: '06:15' }, meals: {}, sleep: {}, missing: [] }],
      ]),
    }),
  });
  check('two children checked', () => assert.strictEqual(res.checked, 2));
  check('nobody agreed', () => assert.strictEqual(res.agreed, 0));
  check('two disagreements', () => assert.strictEqual(res.disagreed.length, 2));
  check('both children are named', () => {
    const names = res.disagreed.map(d => d.name).sort();
    assert.deepStrictEqual(names, ['ליה לוין', 'נויה חגי']);
  });
  check('the disagreement carries both sides', () => {
    const noya = res.disagreed.find(d => d.access_id === 'id-1');
    assert.strictEqual(noya.field, 'home.wake_time');
    assert.strictEqual(noya.archive, '06:15');
    assert.strictEqual(noya.ours, '');
  });
});

scenario('no archive row yet is not a failure — but it must not read as a clean audit either', async () => {
  const res = await verifyDay({
    branchId: 'b1', sheetId: 's1', date: '2026-09-17',
    deps: deps({ history: [], logs: new Map() }),
  });
  check('checked nothing, reported nothing', () => {
    assert.strictEqual(res.checked, 0);
    assert.deepStrictEqual(res.disagreed, []);
  });
  // The archive job usually writes tonight's row well after this check first
  // starts running. `{checked: 0, disagreed: []}` is EXACTLY what a real,
  // fully-audited, zero-disagreement night also looks like — archive_found
  // is the only field that tells the two apart, and a caller that ignores it
  // would report a clean night having examined nothing.
  check('archive_found is false — nothing was actually compared yet', () => {
    assert.strictEqual(res.archive_found, false);
  });
});

scenario('an archive row whose JSON does not parse is reported, not thrown', async () => {
  const res = await verifyDay({
    branchId: 'b1', sheetId: 's1', date: '2026-09-17',
    deps: deps({
      history: [['2026-09-17', '{not json', '2026-09-17 | 23:35']],
      logs: new Map(),
    }),
  });
  check('nothing checked', () => assert.strictEqual(res.checked, 0));
  check('nothing disagreed', () => assert.deepStrictEqual(res.disagreed, []));
  check('the parse failure is named, not swallowed', () => {
    assert.ok(res.error, 'expected an error field explaining the corrupt row');
  });
  check('archive_found is still true — a row that will not parse still proves a row exists', () => {
    assert.strictEqual(res.archive_found, true);
  });
});

scenario('a child in the archive that no Child carries the id for is skipped, not guessed at', async () => {
  const res = await verifyDay({
    branchId: 'b1', sheetId: 's1', date: '2026-09-17',
    deps: deps({
      history: [archiveRow('2026-09-17', [
        kid('id-1', 'נויה חגי', { 'התעורר בבית': '06:15' }),
        kid('id-9', 'ילד עזב', { 'התעורר בבית': '06:00' }),
      ])],
      logs: new Map([['c1', { home: { wake_time: '06:15' }, meals: {}, sleep: {}, missing: [] }]]),
      // The lookup only ever answers about id-1 — id-9 belongs to nobody
      // current, exactly like a child who left the gan since the archive ran.
      children: new Map([['id-1', { _id: 'c1', child_name: 'נויה חגי' }]]),
    }),
  });
  check('only the resolvable child is checked', () => assert.strictEqual(res.checked, 1));
  check('the unresolved child raises no disagreement about a name it cannot attach to anyone', () => {
    assert.ok(!res.disagreed.some(d => d.access_id === 'id-9'));
  });
  check('but it is not silent either — this is the one alarm identity failures have', () => {
    const u = res.unresolved.find(x => x.access_id === 'id-9');
    assert.ok(u, 'expected id-9 to be named in unresolved');
    assert.strictEqual(u.name, 'ילד עזב');
    assert.match(u.why, /no single Child/);
  });
});

scenario('an accessId two Child documents share is a named alarm, not a quiet skip', async () => {
  // From outside, a duplicated sheet_access_id and a withdrawn child's id are
  // the same observation: the lookup has nothing to hand back. `defaultDeps`
  // collapses both into "absent from the Map" (see the $in guard below), so
  // one scenario covers both underlying causes, same as run.js.
  const res = await verifyDay({
    branchId: 'b1', sheetId: 's1', date: '2026-09-17',
    deps: deps({
      history: [archiveRow('2026-09-17', [kid('id-1', 'נויה חגי', { 'התעורר בבית': '06:15' })])],
      logs: new Map(),
      // Two Child documents both carry id-1 in real life; the lookup refuses
      // to pick one and answers about nobody, exactly like `run.js`'s own
      // de-duplication.
      children: new Map(),
    }),
  });
  check('nothing is checked — there is no single child to compare against', () => assert.strictEqual(res.checked, 0));
  check('the ambiguous id is named, not dropped', () => {
    const u = res.unresolved.find(x => x.access_id === 'id-1');
    assert.ok(u, 'expected id-1 to be named in unresolved');
    assert.strictEqual(u.name, 'נויה חגי');
  });
});

scenario('a lookup that answers about something it was never asked about is reported, not used', async () => {
  const res = await verifyDay({
    branchId: 'b1', sheetId: 's1', date: '2026-09-17',
    deps: deps({
      history: [archiveRow('2026-09-17', [kid('id-1', 'נויה חגי', { 'התעורר בבית': '06:15' })])],
      logs: new Map([['c1', { home: { wake_time: '06:15' }, meals: {}, sleep: {}, missing: [] }]]),
      // The fake lookup hands back an extra child nobody asked about — the
      // same defensive check run.js makes against a misbehaving dependency.
      children: new Map([
        ['id-1', { _id: 'c1', child_name: 'נויה חגי' }],
        ['id-99', { _id: 'c9', child_name: 'ילד אחר לגמרי' }],
      ]),
    }),
  });
  check('the asked-for child is still checked normally', () => assert.strictEqual(res.checked, 1));
  check('the unasked-for answer is reported, never compared', () => {
    const u = res.unresolved.find(x => x.access_id === 'id-99');
    assert.ok(u, 'expected id-99 to be named in unresolved');
    assert.match(u.why, /never asked/);
    assert.ok(!res.disagreed.some(d => d.access_id === 'id-99'));
  });
});

scenario('an archive cell that cannot be read is not compared as if it said nothing', async () => {
  // Reproduces the reviewer's exact case: a garbled time cell against a real
  // value on our side must not report "the archive said blank" — that turns a
  // data-quality artifact into a manufactured identity alarm, on the one
  // report where a false alarm costs the most.
  const res = await verifyDay({
    branchId: 'b1', sheetId: 's1', date: '2026-09-17',
    deps: deps({
      history: [archiveRow('2026-09-17', [kid('id-1', 'נויה חגי', { 'התעורר בבית': 'garbled-not-a-time' })])],
      logs: new Map([['c1', { home: { wake_time: '06:15' }, meals: {}, sleep: {}, missing: [] }]]),
    }),
  });
  check('no disagreement is manufactured from an unreadable cell', () => {
    assert.deepStrictEqual(res.disagreed, []);
  });
  check('the child still agrees — nothing readable to disagree about', () => assert.strictEqual(res.agreed, 1));
  check('the unreadable cell is its own reported signal', () => {
    assert.strictEqual(res.unreadable.length, 1);
    assert.strictEqual(res.unreadable[0].access_id, 'id-1');
    assert.strictEqual(res.unreadable[0].field, 'home.wake_time');
  });
});

scenario('an unreadable cell does not block a real disagreement on another field in the same row', async () => {
  const res = await verifyDay({
    branchId: 'b1', sheetId: 's1', date: '2026-09-17',
    deps: deps({
      history: [archiveRow('2026-09-17', [kid('id-1', 'נויה חגי', {
        'התעורר בבית': 'garbled-not-a-time',
        'הערות': 'ישנה טוב',
      })])],
      logs: new Map([['c1', { home: { wake_time: '06:15' }, meals: {}, sleep: {}, missing: [], staff_note: '' }]]),
    }),
  });
  check('the unreadable field is excluded, not treated as agreement or disagreement', () => {
    assert.ok(!res.disagreed.some(d => d.field === 'home.wake_time'));
  });
  check('the readable field still disagrees normally', () => {
    assert.ok(res.disagreed.some(d => d.field === 'staff_note'));
  });
  check('one unreadable field is reported', () => assert.strictEqual(res.unreadable.length, 1));
});

scenario('a field the archive never asked about is not compared, even if our record disagrees', async () => {
  const res = await verifyDay({
    branchId: 'b1', sheetId: 's1', date: '2026-09-17',
    deps: deps({
      // The archive's only column for this child is wake_time — it says
      // nothing about staff_note, so a staff_note our side holds is not "the
      // archive says blank", it is a question the archive was never asked.
      history: [archiveRow('2026-09-17', [kid('id-1', 'נויה חגי', { 'התעורר בבית': '06:15' })])],
      logs: new Map([['c1', {
        home: { wake_time: '06:15' }, meals: {}, sleep: {}, missing: [], staff_note: 'ישנה מצוין',
      }]]),
    }),
  });
  check('agrees — the unasked field is not a disagreement', () => {
    assert.strictEqual(res.agreed, 1);
    assert.deepStrictEqual(res.disagreed, []);
  });
});

scenario('a field the archive carries blank while our side has never heard of it agrees', async () => {
  const res = await verifyDay({
    branchId: 'b1', sheetId: 's1', date: '2026-09-17',
    deps: deps({
      history: [archiveRow('2026-09-17', [kid('id-1', 'נויה חגי', { 'הערת הורים': '' })])],
      // The log document itself has no `home` key at all — never written.
      logs: new Map([['c1', { meals: {}, sleep: {}, missing: [] }]]),
    }),
  });
  check('blank on both sides is agreement, not a missing-field disagreement', () => {
    assert.strictEqual(res.agreed, 1);
    assert.deepStrictEqual(res.disagreed, []);
  });
});

scenario('a field the archive carries a real value for, and our record has never heard of, disagrees', async () => {
  const res = await verifyDay({
    branchId: 'b1', sheetId: 's1', date: '2026-09-17',
    deps: deps({
      history: [archiveRow('2026-09-17', [kid('id-1', 'נויה חגי', { 'התעורר בבית': '06:15' })])],
      logs: new Map([['c1', { meals: {}, sleep: {}, missing: [] }]]),
    }),
  });
  check('one disagreement, ours reported as blank rather than undefined', () => {
    assert.strictEqual(res.disagreed.length, 1);
    assert.strictEqual(res.disagreed[0].ours, '');
    assert.strictEqual(res.disagreed[0].archive, '06:15');
  });
});

scenario('a list-valued field compares by position, same as the live sync', async () => {
  const res = await verifyDay({
    branchId: 'b1', sheetId: 's1', date: '2026-09-17',
    deps: deps({
      history: [archiveRow('2026-09-17', [kid('id-1', 'נויה חגי', { 'מה חסר': 'טיטולים, מגבונים' })])],
      logs: new Map([['c1', { home: {}, meals: {}, sleep: {}, missing: ['מגבונים', 'טיטולים'] }]]),
    }),
  });
  check('same items, different order, is a disagreement — reordering IS the edit', () => {
    assert.strictEqual(res.disagreed.length, 1);
    assert.deepStrictEqual(res.disagreed[0].archive, ['טיטולים', 'מגבונים']);
    assert.deepStrictEqual(res.disagreed[0].ours, ['מגבונים', 'טיטולים']);
  });
});

scenario('a list-valued field that matches in order agrees', async () => {
  const res = await verifyDay({
    branchId: 'b1', sheetId: 's1', date: '2026-09-17',
    deps: deps({
      history: [archiveRow('2026-09-17', [kid('id-1', 'נויה חגי', { 'מה חסר': 'טיטולים, מגבונים' })])],
      logs: new Map([['c1', { home: {}, meals: {}, sleep: {}, missing: ['טיטולים', 'מגבונים'] }]]),
    }),
  });
  check('agrees', () => { assert.strictEqual(res.agreed, 1); assert.deepStrictEqual(res.disagreed, []); });
});

// Two rows for one date happened for real: the archive job fired twice on
// three of Kaplan's 240 days, and on one of them the LATER run held an empty
// board because it fired after the nightly reset had already wiped the sheet
// (see scripts/lib/nursery-history.js, chooseSnapshot). This suite does not
// import chooseSnapshot's "richest wins" behaviour — that is a decision about
// which snapshot to trust, and this task's job is only to compare what is
// there — but the current row lookup takes the FIRST matching row, which this
// pins down explicitly rather than leaving to whatever Array#find happens to
// do. See the report for why this is flagged as worth a second look rather
// than fixed quietly here.
scenario('two archive rows for the same date: the first one found is the one used', async () => {
  const res = await verifyDay({
    branchId: 'b1', sheetId: 's1', date: '2026-09-17',
    deps: deps({
      history: [
        archiveRow('2026-09-17', [kid('id-1', 'נויה חגי', { 'התעורר בבית': '06:15' })], '2026-09-17 | 23:30'),
        archiveRow('2026-09-17', [], '2026-09-17 | 23:45'),
      ],
      logs: new Map([['c1', { home: { wake_time: '06:15' }, meals: {}, sleep: {}, missing: [] }]]),
    }),
  });
  check('the first row (one real child) is used, not the second (empty)', () => {
    assert.strictEqual(res.checked, 1);
    assert.strictEqual(res.agreed, 1);
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
