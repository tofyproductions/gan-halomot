/**
 * One pass, end to end, with the sheet and the database injected.
 *
 * The point of the injection is that this suite asserts the ORDER of
 * operations — the shadow written only after the writes it describes have
 * landed — which is not observable from the outside. A pass that advances the
 * shadow first and then fails on the sheet looks, from any later pass, exactly
 * like a pass where nobody changed anything, and both sides' edits are gone.
 * So the deps record the order they were called in, and one scenario makes the
 * sheet write fail on purpose.
 *
 *   node scripts/sheet-sync-run.test.js
 */
const assert = require('assert');
const { runPass, COLUMN_FOR_PATH } = require('../src/services/sheet-sync/run');
const { SHEET, splitMissing, FIELD_MAP } = require('./lib/nursery-history');

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures += 1; console.log(`  ✗ ${label} — ${e.message}`); }
}

const childGrid = [
  ['ילדים - משה דיין', '', '', ''],
  ['שם מלא', 'תאריך לידה', 'AccessID', 'מספר פלאפון'],
  ['נויה חגי', 45897, 'id-1', '0500000000'],
  ['ליה לוין', 45887, 'id-2', '0500000000'],
];

const DEFAULT_HEADER = ['התעורר בבית', 'אכל בבית - שעה', 'ארוחת בוקר', 'הערות'];
function todayGrid(rows, header = DEFAULT_HEADER) { return [['סדר יום'], header, ...rows]; }

// The Child rows the database would hand back. `child_name` is the field that
// exists — there is no `full_name` on Child — and the board's snapshot of the
// name comes from here, so a wrong field name here is a silently empty name on
// every log this pass writes.
function twoChildren() {
  return new Map([
    ['id-1', { _id: 'c1', child_name: 'נויה חגי', sheet_access_id: 'id-1', classroom_id: 'room-1' }],
    ['id-2', { _id: 'c2', child_name: 'ליה לוין', sheet_access_id: 'id-2', classroom_id: 'room-1' }],
  ]);
}

function deps({ today, logs, shadow, children, roster, failWrite, looseAnswers }) {
  const writes = [];
  const saved = [];
  const calls = [];
  const state = { shadowSaved: null, shadowCtx: null };
  return {
    writes, saved, calls, state,
    readGrids: async () => {
      calls.push('readGrids');
      return { children: roster || childGrid, today, history: [] };
    },
    writeCells: async (_id, updates) => {
      calls.push('writeCells');
      if (failWrite) throw new Error('the sheet refused the write');
      writes.push(...updates);
      return { written: updates.length };
    },
    childrenByAccessId: async (accessIds) => {
      calls.push('childrenByAccessId');
      state.askedFor = accessIds;
      const all = children || twoChildren();
      // A real lookup answers about what it was asked and nothing else. One
      // scenario deliberately breaks that to prove the pass notices.
      if (looseAnswers) return all;
      return new Map([...all].filter(([id]) => accessIds.includes(id)));
    },
    loadLogs: async () => { calls.push('loadLogs'); return logs; },
    saveLog: async (childId, set, conflicts, ctx) => {
      calls.push('saveLog');
      saved.push({ childId, set, conflicts, ctx });
    },
    loadShadow: async () => { calls.push('loadShadow'); return shadow; },
    saveShadow: async (s, ctx) => { calls.push('saveShadow'); state.shadowSaved = s; state.shadowCtx = ctx; },
  };
}

const scenarios = [];
function scenario(title, fn) { scenarios.push({ title, fn }); }

// --- 1: nothing remembered yet -------------------------------------------

scenario('a first pass with no shadow takes the sheet as it stands', async () => {
  const d = deps({
    today: todayGrid([[0.2604166666666667, 0.25, '', ''], ['', '', '', '']]),
    logs: new Map(),
    shadow: {},
  });
  const returned = runPass({ branchId: 'b1', sheetId: 's1', date: '2026-09-17', mode: 'write', deps: d });
  check('it resolves', () => assert.ok(returned instanceof Promise));
  const res = await returned;

  check('two children seen', () => assert.strictEqual(res.children, 2));
  check("נויה's wake time copied in", () => {
    const s = d.saved.find(x => x.childId === 'c1');
    assert.strictEqual(s.set['home.wake_time'], '06:15');
  });
  check('the name on the log comes from Child.child_name', () => {
    const s = d.saved.find(x => x.childId === 'c1');
    assert.strictEqual(s.ctx.childName, 'נויה חגי');
  });
  check('the log is filed under the branch and the classroom', () => {
    const s = d.saved.find(x => x.childId === 'c1');
    assert.strictEqual(s.ctx.branchId, 'b1');
    assert.strictEqual(s.ctx.classroomId, 'room-1');
  });
  check('no writes back out', () => assert.strictEqual(d.writes.length, 0));
  check('the shadow was recorded', () => assert.ok(d.state.shadowSaved && d.state.shadowSaved['id-1']));
  check('the shadow is the last thing that happened', () => {
    assert.strictEqual(d.calls[d.calls.length - 1], 'saveShadow');
    assert.strictEqual(d.calls.filter(c => c === 'saveShadow').length, 1);
  });
  check('every saveLog landed before the shadow', () => {
    const shadowAt = d.calls.indexOf('saveShadow');
    assert.ok(d.calls.every((c, i) => c !== 'saveLog' || i < shadowAt));
  });
  check('the shadow carries the counters the run reported', () => {
    assert.strictEqual(d.state.shadowCtx.in, res.in);
    assert.strictEqual(d.state.shadowCtx.conflicts, res.conflicts);
  });
});

// --- 2: dry ---------------------------------------------------------------

scenario('dry mode writes nothing at all', async () => {
  const d = deps({
    today: todayGrid([[0.2604166666666667, '', '', ''], ['', '', '', '']]),
    logs: new Map([['c1', { staff_note: 'ישן טוב', home: {}, meals: {}, sleep: {}, missing: [] }]]),
    shadow: { 'id-1': { staff_note: '' } },
  });
  const res = await runPass({ branchId: 'b1', sheetId: 's1', date: '2026-09-17', mode: 'dry', deps: d });

  check('it still reports what it would do', () => assert.ok(res.in > 0));
  check('it still reports what it would send out', () => assert.ok(res.out > 0));
  check('nothing saved to the database', () => assert.strictEqual(d.saved.length, 0));
  check('nothing written to the sheet', () => assert.strictEqual(d.writes.length, 0));
  check('writeCells was never even called', () => assert.ok(!d.calls.includes('writeCells')));
  check('the shadow is NOT advanced', () => assert.strictEqual(d.state.shadowSaved, null));
});

// --- 3: our edit goes out -------------------------------------------------

scenario('we changed a field the sheet did not: it goes out to the sheet', async () => {
  const d = deps({
    today: todayGrid([['', '', '', ''], ['', '', '', '']]),
    logs: new Map([['c1', { staff_note: 'ישן טוב', home: {}, meals: {}, sleep: {}, missing: [] }]]),
    shadow: { 'id-1': { staff_note: '' } },
  });
  const res = await runPass({ branchId: 'b1', sheetId: 's1', date: '2026-09-17', mode: 'write', deps: d });

  check('one cell written out', () => assert.strictEqual(d.writes.length, 1));
  check("to the הערות column, נויה's row", () => {
    assert.strictEqual(d.writes[0].col, 3);
    assert.strictEqual(d.writes[0].row, 2);
    assert.strictEqual(d.writes[0].value, 'ישן טוב');
  });
  check('onto the live tab, named from SHEET', () => assert.strictEqual(d.writes[0].tab, SHEET.today));
  check('and it is counted as one going out', () => assert.strictEqual(res.out, 1));
  check('the target sits inside the grid this pass read', () => {
    const grid = todayGrid([['', '', '', ''], ['', '', '', '']]);
    assert.ok(d.writes[0].row < grid.length, 'row past the grid');
    assert.ok(d.writes[0].col < DEFAULT_HEADER.length, 'column past the header');
  });
  check('the sheet was written before the shadow advanced', () => {
    assert.ok(d.calls.indexOf('writeCells') < d.calls.indexOf('saveShadow'));
  });
  check('the shadow now claims the sheet holds our value', () => {
    assert.strictEqual(d.state.shadowSaved['id-1'].staff_note, 'ישן טוב');
  });
});

// --- 4: both moved --------------------------------------------------------

scenario('both moved: the sheet wins and ours is kept on the log', async () => {
  const d = deps({
    today: todayGrid([['', '', 1, ''], ['', '', '', '']]),
    logs: new Map([['c1', { meals: { breakfast: { amount: '50%' } }, home: {}, sleep: {}, missing: [] }]]),
    shadow: { 'id-1': { 'meals.breakfast.amount': '' } },
  });
  const res = await runPass({ branchId: 'b1', sheetId: 's1', date: '2026-09-17', mode: 'write', deps: d });

  check('one conflict', () => assert.strictEqual(res.conflicts, 1));
  check("the sheet's 100% is what we store", () => {
    const s = d.saved.find(x => x.childId === 'c1');
    assert.strictEqual(s.set['meals.breakfast.amount'], '100%');
  });
  check('our 50% is kept', () => {
    const s = d.saved.find(x => x.childId === 'c1');
    assert.strictEqual(s.conflicts[0].ours, '50%');
  });
  check('the kept value names its field and its moment', () => {
    const s = d.saved.find(x => x.childId === 'c1');
    assert.strictEqual(s.conflicts[0].field, 'meals.breakfast.amount');
    assert.ok(s.conflicts[0].at instanceof Date);
  });
  check('nothing was pushed back to the sheet', () => assert.strictEqual(d.writes.length, 0));
});

// --- 5: an identity we do not hold ---------------------------------------

scenario('a child with no sheet_access_id is skipped, never guessed', async () => {
  const d = deps({
    today: todayGrid([['', '', '', ''], ['', '', '', '']]),
    logs: new Map(),
    shadow: {},
    children: new Map([['id-1', { _id: 'c1', child_name: 'נויה חגי', classroom_id: null }]]),
  });
  const res = await runPass({ branchId: 'b1', sheetId: 's1', date: '2026-09-17', mode: 'write', deps: d });

  check('ליה לוין is reported as skipped', () => assert.ok(res.skipped.some(s => /id-2/.test(JSON.stringify(s)))));
  check('and she gets no shadow entry, because nothing was agreed about her', () => {
    assert.ok(!Object.prototype.hasOwnProperty.call(d.state.shadowSaved, 'id-2'));
  });
});

scenario('a roster row with a blank AccessID is never looked up', async () => {
  const roster = [
    ['ילדים - משה דיין', '', '', ''],
    ['שם מלא', 'תאריך לידה', 'AccessID', 'מספר פלאפון'],
    ['נויה חגי', 45897, 'id-1', '0500000000'],
    ['ילד ללא מזהה', 45887, '', '0500000000'],
  ];
  const d = deps({
    roster,
    today: todayGrid([['', '', '', ''], ['', '', '', '']]),
    logs: new Map(),
    shadow: {},
    // A Child whose sheet_access_id was never filled in holds '' by default.
    // Looking '' up would hand this row somebody else's day.
    children: new Map([
      ['id-1', { _id: 'c1', child_name: 'נויה חגי', classroom_id: null }],
      ['', { _id: 'c9', child_name: 'ילד אחר לגמרי', classroom_id: null }],
    ]),
  });
  const res = await runPass({ branchId: 'b1', sheetId: 's1', date: '2026-09-17', mode: 'write', deps: d });

  check('the blank id is never asked about', () => assert.ok(!d.state.askedFor.includes('')));
  check('the row is reported as skipped', () => {
    assert.ok(res.skipped.some(s => s.name === 'ילד ללא מזהה'));
  });
  check('and no log was written for the child that happens to hold ""', () => {
    assert.ok(!d.saved.some(s => s.childId === 'c9'));
  });
});

scenario('two roster rows carrying one AccessID are both left out', async () => {
  const roster = [
    ['ילדים - משה דיין', '', '', ''],
    ['שם מלא', 'תאריך לידה', 'AccessID', 'מספר פלאפון'],
    ['נויה חגי', 45897, 'id-1', '0500000000'],
    // The row below נויה was copy-pasted and the AccessID came with it.
    ['ליה לוין', 45887, 'id-1', '0500000000'],
    ['יובל ראובני', 45895, 'id-3', '0500000000'],
  ];
  const d = deps({
    roster,
    today: todayGrid([['', '', '', ''], ['', '', '', ''], ['', '', '', '']]),
    logs: new Map([['c1', { staff_note: 'ישן טוב', home: {}, meals: {}, sleep: {}, missing: [] }]]),
    shadow: { 'id-1': { staff_note: '' } },
    children: new Map([
      ['id-1', { _id: 'c1', child_name: 'נויה חגי', classroom_id: null }],
      ['id-3', { _id: 'c3', child_name: 'יובל ראובני', classroom_id: null }],
    ]),
  });
  const res = await runPass({ branchId: 'b1', sheetId: 's1', date: '2026-09-17', mode: 'write', deps: d });

  check('the repeated id is never asked about', () => assert.ok(!d.state.askedFor.includes('id-1')));
  check('both rows that carry it are reported', () => {
    const both = res.skipped.filter(s => s.access_id === 'id-1');
    assert.strictEqual(both.length, 2);
    assert.ok(both.every(s => /more than one roster row/.test(s.why)));
  });
  check('nothing is written into either of their rows', () => assert.strictEqual(d.writes.length, 0));
  check('no log is written for the one child they both resolve to', () => {
    assert.ok(!d.saved.some(s => s.childId === 'c1'));
  });
  check('the child on the row that is fine is still synced', () => {
    assert.ok(res.skipped.every(s => s.access_id !== 'id-3'));
    assert.ok(Object.prototype.hasOwnProperty.call(d.state.shadowSaved, 'id-3'));
  });
  check('and no shadow claims anything about the repeated id', () => {
    assert.ok(!Object.prototype.hasOwnProperty.call(d.state.shadowSaved, 'id-1'));
  });
});

scenario('a lookup that answers about something else is reported, not used', async () => {
  const d = deps({
    today: todayGrid([['', '', '', ''], ['', '', '', '']]),
    logs: new Map(),
    shadow: {},
    looseAnswers: true,
    // One id missing — no single Child carries it, which is what the default
    // lookup does when two Child documents share one — and one id nobody asked
    // about.
    children: new Map([
      ['id-1', { _id: 'c1', child_name: 'נויה חגי', classroom_id: null }],
      ['id-99', { _id: 'c9', child_name: 'ילד אחר לגמרי', classroom_id: null }],
    ]),
  });
  const res = await runPass({ branchId: 'b1', sheetId: 's1', date: '2026-09-17', mode: 'write', deps: d });

  check('the id that resolved to nothing is reported', () => {
    assert.ok(res.skipped.some(s => s.access_id === 'id-2' && /no single Child/.test(s.why)));
  });
  check('the unasked-for answer is reported', () => {
    assert.ok(res.skipped.some(s => s.access_id === 'id-99' && /never asked/.test(s.why)));
  });
  check('and it is never synced', () => {
    assert.ok(!d.saved.some(s => s.childId === 'c9'));
    assert.ok(!Object.prototype.hasOwnProperty.call(d.state.shadowSaved, 'id-99'));
  });
});

// --- 6: the pairing refused ----------------------------------------------

scenario('pairRows refusing aborts the pass instead of half-applying it', async () => {
  const d = deps({
    // Two children on the roster, one row on the live tab: mid-edit, or the
    // assumption is wrong. Either way a partial pairing writes a day onto the
    // wrong child.
    today: todayGrid([['', '', '', '']]),
    logs: new Map([['c1', { staff_note: 'ישן טוב', home: {}, meals: {}, sleep: {}, missing: [] }]]),
    shadow: { 'id-1': { staff_note: '' } },
  });
  const res = await runPass({ branchId: 'b1', sheetId: 's1', date: '2026-09-17', mode: 'write', deps: d });

  check('it reports the refusal', () => assert.ok(res.errors.length > 0));
  check('no children counted', () => assert.strictEqual(res.children, 0));
  check('nothing saved', () => assert.strictEqual(d.saved.length, 0));
  check('nothing written', () => assert.strictEqual(d.writes.length, 0));
  check('the shadow is not advanced', () => assert.strictEqual(d.state.shadowSaved, null));
  check('the database was not even read', () => assert.ok(!d.calls.includes('childrenByAccessId')));
});

scenario('two columns that normalise to one name abort the pass', async () => {
  const d = deps({
    // The second הערות carries a trailing newline, which is what a header
    // typed into a wrapped cell looks like. Read by name the last one wins;
    // located by index the first one does. Writing one and reading the other
    // is worse than not syncing.
    today: todayGrid([['', '', '', ''], ['', '', '', '']], ['התעורר בבית', 'הערות', 'הערות\n', 'ארוחת בוקר']),
    logs: new Map([['c1', { staff_note: 'ישן טוב', home: {}, meals: {}, sleep: {}, missing: [] }]]),
    shadow: { 'id-1': { staff_note: '' } },
  });
  const res = await runPass({ branchId: 'b1', sheetId: 's1', date: '2026-09-17', mode: 'write', deps: d });

  check('it reports the refusal', () => assert.ok(res.errors.length > 0));
  check('and names the column', () => assert.ok(/הערות/.test(res.errors[0])));
  check('nothing written to the sheet', () => assert.strictEqual(d.writes.length, 0));
  check('nothing saved', () => assert.strictEqual(d.saved.length, 0));
  check('the shadow is not advanced', () => assert.strictEqual(d.state.shadowSaved, null));
});

// --- 7: a column we hold nothing for, on a child with no day yet ----------

scenario('a sheet column we hold nothing for lands on a child with no log yet', async () => {
  const header = ['התעורר בבית', 'יציאות', 'הערות'];
  const d = deps({
    today: todayGrid([['', '2', ''], ['', '', '']], header),
    logs: new Map(),
    shadow: {},
  });
  const res = await runPass({ branchId: 'b1', sheetId: 's1', date: '2026-09-17', mode: 'write', deps: d });

  check('the value comes in', () => {
    const s = d.saved.find(x => x.childId === 'c1');
    assert.strictEqual(s.set.diapers, '2');
  });
  check('one field in', () => assert.strictEqual(res.in, 1));
  check('nothing goes back out', () => assert.strictEqual(res.out, 0));
});

// --- 8: a column the sheet does not have ----------------------------------

scenario('a column the grid does not have is a question the sheet was never asked', async () => {
  const header = ['התעורר בבית', 'ארוחת בוקר'];
  const d = deps({
    today: todayGrid([['', ''], ['', '']], header),
    // We hold a staff note, and the live tab has no הערות column at all.
    logs: new Map([['c1', { staff_note: 'ישן טוב', home: {}, meals: {}, sleep: {}, missing: [] }]]),
    shadow: { 'id-1': { staff_note: '' } },
  });
  const res = await runPass({ branchId: 'b1', sheetId: 's1', date: '2026-09-17', mode: 'write', deps: d });

  check('nothing is written into a column that does not exist', () => assert.strictEqual(d.writes.length, 0));
  check('and nothing is counted as going out', () => assert.strictEqual(res.out, 0));
  check('the shadow makes no claim about that field', () => {
    assert.ok(!Object.prototype.hasOwnProperty.call(d.state.shadowSaved['id-1'], 'staff_note'));
  });
});

// --- 9: a cleared cell ----------------------------------------------------

scenario('a cell the room cleared is a change, and it comes in as a clear', async () => {
  const header = ['התעורר בבית', 'הערות'];
  const d = deps({
    today: todayGrid([['', ''], ['', '']], header),
    logs: new Map([['c1', { staff_note: 'ישן טוב', home: {}, meals: {}, sleep: {}, missing: [] }]]),
    // Last pass the sheet held the note too. It does not any more.
    shadow: { 'id-1': { staff_note: 'ישן טוב' } },
  });
  const res = await runPass({ branchId: 'b1', sheetId: 's1', date: '2026-09-17', mode: 'write', deps: d });

  check('the clear reaches our record', () => {
    const s = d.saved.find(x => x.childId === 'c1');
    assert.ok(Object.prototype.hasOwnProperty.call(s.set, 'staff_note'));
    assert.strictEqual(s.set.staff_note, '');
  });
  check('it counts as one coming in', () => assert.strictEqual(res.in, 1));
  check('it is not a conflict — only one side moved', () => assert.strictEqual(res.conflicts, 0));
});

// --- 10: a list-valued conflict -------------------------------------------

scenario('both moved on מה חסר: the sheet wins and our list is kept whole', async () => {
  const header = ['התעורר בבית', 'מה חסר'];
  const d = deps({
    today: todayGrid([['', 'טיטולים, מגבונים'], ['', '']], header),
    logs: new Map([['c1', { missing: ['משחת החתלה'], home: {}, meals: {}, sleep: {} }]]),
    shadow: { 'id-1': { missing: [] } },
  });
  const res = await runPass({ branchId: 'b1', sheetId: 's1', date: '2026-09-17', mode: 'write', deps: d });

  check('one conflict', () => assert.strictEqual(res.conflicts, 1));
  check("the sheet's list is what we store", () => {
    const s = d.saved.find(x => x.childId === 'c1');
    assert.deepStrictEqual(s.set.missing, ['טיטולים', 'מגבונים']);
  });
  check('our list is kept as a list, not flattened to a string', () => {
    const s = d.saved.find(x => x.childId === 'c1');
    assert.deepStrictEqual(s.conflicts[0].ours, ['משחת החתלה']);
  });
});

// --- 10b: the list's round trip back to the cell --------------------------
//
// `join(', ')` in run.js is the only place a list crosses back to the sheet,
// and the sheet's own reader is `splitMissing`. Nothing else in this suite
// touches the join — scenario 10 is incoming — so without this a change to
// either side breaks the mirror with every test still green.

scenario('a list we hold goes out as one cell the sheet can read back', async () => {
  const header = ['התעורר בבית', 'מה חסר'];
  const d = deps({
    today: todayGrid([['', ''], ['', '']], header),
    logs: new Map([['c1', { missing: ['טיטולים', 'מגבונים'], home: {}, meals: {}, sleep: {} }]]),
    shadow: { 'id-1': { missing: [] } },
  });
  await runPass({ branchId: 'b1', sheetId: 's1', date: '2026-09-17', mode: 'write', deps: d });

  check('one cell written', () => assert.strictEqual(d.writes.length, 1));
  check('joined exactly as the board has always shown it', () => {
    assert.strictEqual(d.writes[0].value, 'טיטולים, מגבונים');
  });
  check('and the sheet\'s own reader gets the list back unchanged', () => {
    assert.deepStrictEqual(splitMissing(d.writes[0].value), ['טיטולים', 'מגבונים']);
  });
});

scenario('a list we emptied clears the cell, and reads back as empty', async () => {
  const header = ['התעורר בבית', 'מה חסר'];
  const d = deps({
    // The sheet still holds what it held last pass; we are the side that
    // emptied the list.
    today: todayGrid([['', 'טיטולים'], ['', '']], header),
    logs: new Map([['c1', { missing: [], home: {}, meals: {}, sleep: {} }]]),
    shadow: { 'id-1': { missing: ['טיטולים'] } },
  });
  await runPass({ branchId: 'b1', sheetId: 's1', date: '2026-09-17', mode: 'write', deps: d });

  check('one cell written', () => assert.strictEqual(d.writes.length, 1));
  check('and it is emptied, not left holding the old item', () => {
    assert.strictEqual(d.writes[0].value, '');
  });
  check('which the sheet\'s reader takes as an empty list', () => {
    assert.deepStrictEqual(splitMissing(d.writes[0].value), []);
  });
});

// --- 11: a cell we cannot read is not a clear -----------------------------

scenario('a cell that holds something unreadable is left alone, not treated as cleared', async () => {
  const header = ['התעורר בבית', 'הערות'];
  const d = deps({
    // 3.5 is not a time — it is millilitres in the wrong column. Reading it as
    // "" would push a wipe of a real wake time into our record.
    today: todayGrid([[3.5, ''], ['', '']], header),
    logs: new Map([['c1', { home: { wake_time: '06:15' }, staff_note: '', meals: {}, sleep: {}, missing: [] }]]),
    shadow: { 'id-1': { 'home.wake_time': '06:15', staff_note: '' } },
  });
  const res = await runPass({ branchId: 'b1', sheetId: 's1', date: '2026-09-17', mode: 'write', deps: d });

  check('nothing is written to the database', () => assert.strictEqual(d.saved.length, 0));
  check('nothing is written to the sheet', () => assert.strictEqual(d.writes.length, 0));
  check('the unreadable cell is reported', () => {
    assert.ok(res.skipped.some(s => s.field === 'התעורר בבית'));
  });
  check('and the shadow makes no claim about a field nobody could read', () => {
    assert.ok(!Object.prototype.hasOwnProperty.call(d.state.shadowSaved['id-1'] || {}, 'home.wake_time'));
  });
});

// --- 12: a log document older than the fields on it -----------------------

scenario('a log read through .lean() with no defaults filled in does not break the pass', async () => {
  const header = ['התעורר בבית', 'מה חסר'];
  const d = deps({
    today: todayGrid([['', 'טיטולים'], ['', '']], header),
    // What a document written before `missing` and `sync_conflicts` existed
    // reads back as: the fields are simply not there. `.lean()` does not apply
    // a schema default.
    logs: new Map([['c1', { _id: 'log1', child_id: 'c1', date: '2026-09-17' }]]),
    shadow: {},
  });
  const res = await runPass({ branchId: 'b1', sheetId: 's1', date: '2026-09-17', mode: 'write', deps: d });

  check('the pass completes', () => assert.strictEqual(res.errors.length, 0));
  check('the list comes in', () => {
    const s = d.saved.find(x => x.childId === 'c1');
    assert.deepStrictEqual(s.set.missing, ['טיטולים']);
  });
});

// --- 13: the ordering, proven by breaking it ------------------------------

scenario('a sheet write that fails must not leave an advanced shadow behind', async () => {
  const d = deps({
    today: todayGrid([['', '', '', ''], ['', '', '', '']]),
    logs: new Map([['c1', { staff_note: 'ישן טוב', home: {}, meals: {}, sleep: {}, missing: [] }]]),
    shadow: { 'id-1': { staff_note: '' } },
    failWrite: true,
  });
  let threw = null;
  try {
    await runPass({ branchId: 'b1', sheetId: 's1', date: '2026-09-17', mode: 'write', deps: d });
  } catch (e) { threw = e; }

  check('the failure is not swallowed', () => assert.ok(threw));
  check('the shadow was never saved', () => assert.strictEqual(d.state.shadowSaved, null));
  check('so the next pass still sees our edit as an edit', () => {
    assert.ok(!d.calls.includes('saveShadow'));
  });
});

// --- 14: the shadow may only claim what was actually queued ---------------
//
// The shadow's entire meaning is "this is what the sheet holds". The write
// loop declines some cells; if the shadow claims them anyway, the next pass
// sees the sheet disagreeing with a shadow that says our value is already
// there, reads that as "the sheet moved and we did not", and quietly reverts
// the staff member's edit on the new board with no conflict raised.
//
// The live trigger is COLUMN_FOR_PATH losing an entry — two FIELD_MAP columns
// sharing one path silently drops one on inversion. Simulated here by
// deleting an entry, because that is exactly the state the inversion leaves
// behind, and because the guard that is supposed to catch it does not:
// normalizeFieldName(undefined) is '', and header.indexOf('') finds the first
// blank header column, which real boards have trailing.

scenario('a path with no column of its own is not written into a blank column, and not claimed', async () => {
  const header = ['התעורר בבית', 'הערות', ''];
  const d = deps({
    today: todayGrid([['', '', ''], ['', '', '']], header),
    logs: new Map([['c1', { staff_note: 'ישן טוב', home: {}, meals: {}, sleep: {}, missing: [] }]]),
    shadow: { 'id-1': { staff_note: '' } },
  });
  const had = COLUMN_FOR_PATH.staff_note;
  delete COLUMN_FOR_PATH.staff_note;
  let res;
  try {
    res = await runPass({ branchId: 'b1', sheetId: 's1', date: '2026-09-17', mode: 'write', deps: d });
  } finally {
    COLUMN_FOR_PATH.staff_note = had;
  }

  check('nothing is written into the trailing blank column', () => {
    assert.strictEqual(d.writes.length, 0);
  });
  check('and nothing is counted as having gone out', () => assert.strictEqual(res.out, 0));
  check('the shadow states what the sheet really holds, not what we failed to send', () => {
    assert.strictEqual(d.state.shadowSaved['id-1'].staff_note, '');
  });
  check('the refusal is reported rather than passed over in silence', () => {
    const r = res.skipped.find(s => s.field === 'staff_note');
    assert.ok(r, 'expected the declined cell to be reported');
    assert.strictEqual(r.kind, 'cell');
  });
});

scenario('every FIELD_MAP column keeps its own path — the inversion loses nothing', () => {
  check('COLUMN_FOR_PATH has one entry per column', () => {
    assert.strictEqual(Object.keys(COLUMN_FOR_PATH).length, Object.keys(FIELD_MAP).length);
  });
});

// --- 15: a comma inside a מה חסר item ------------------------------------
//
// One cell, one comma-joined list, and the reader splits on the comma. An
// item that contains one is therefore not round-trippable: written out it
// comes back as two items, the next pass sees a sheet that "moved", and our
// two-item list is rewritten to three on the parent-facing board with no
// alarm. Not reachable through the board's multi-select, reachable through
// the API and through an admin-edited options list.

scenario('an item carrying the separator is refused, not written', async () => {
  const header = ['התעורר בבית', 'מה חסר'];
  const d = deps({
    today: todayGrid([['', ''], ['', '']], header),
    logs: new Map([['c1', { missing: ['חיתולים, גדול', 'מגבונים'], home: {}, meals: {}, sleep: {} }]]),
    shadow: { 'id-1': { missing: [] } },
  });
  const res = await runPass({ branchId: 'b1', sheetId: 's1', date: '2026-09-17', mode: 'write', deps: d });

  check('the cell is not written', () => assert.strictEqual(d.writes.length, 0));
  check('the shadow keeps saying what the sheet holds', () => {
    assert.deepStrictEqual(d.state.shadowSaved['id-1'].missing, []);
  });
  check('and the item is named so somebody can fix it', () => {
    const r = res.skipped.find(s => s.field === 'missing');
    assert.ok(r, 'expected the refused list to be reported');
    assert.strictEqual(r.kind, 'cell');
    assert.ok(/חיתולים, גדול/.test(r.why), 'expected the offending item to be named');
  });
});

scenario('a list with no separator inside an item still goes out normally', async () => {
  const header = ['התעורר בבית', 'מה חסר'];
  const d = deps({
    today: todayGrid([['', ''], ['', '']], header),
    logs: new Map([['c1', { missing: ['חיתולים גדול', 'מגבונים'], home: {}, meals: {}, sleep: {} }]]),
    shadow: { 'id-1': { missing: [] } },
  });
  await runPass({ branchId: 'b1', sheetId: 's1', date: '2026-09-17', mode: 'write', deps: d });
  check('one cell written', () => assert.strictEqual(d.writes.length, 1));
  check('and it reads back as the same two items', () => {
    assert.deepStrictEqual(splitMissing(d.writes[0].value), ['חיתולים גדול', 'מגבונים']);
  });
});

// --- 16: `skipped` is read by a person ------------------------------------

scenario('every skipped entry says which kind of thing was skipped', async () => {
  const roster = [
    ['ילדים - משה דיין', '', '', ''],
    ['שם מלא', 'תאריך לידה', 'AccessID', 'מספר פלאפון'],
    ['נויה חגי', 45897, 'id-1', '0500000000'],
    ['ילד ללא מזהה', 45887, '', '0500000000'],
  ];
  const header = ['התעורר בבית', 'הערות'];
  const d = deps({
    roster,
    // 3.5 is not a time: an unreadable cell, reported as a field rather than
    // as a row, on the same pass as a row with no identity at all.
    today: todayGrid([[3.5, ''], ['', '']], header),
    logs: new Map(),
    shadow: {},
    children: new Map([['id-1', { _id: 'c1', child_name: 'נויה חגי', classroom_id: null }]]),
  });
  const res = await runPass({ branchId: 'b1', sheetId: 's1', date: '2026-09-17', mode: 'write', deps: d });

  check('both kinds are present', () => {
    assert.ok(res.skipped.some(s => s.kind === 'row'), 'expected a skipped row');
    assert.ok(res.skipped.some(s => s.kind === 'field'), 'expected a skipped field');
  });
  check('and nothing is left undiscriminated', () => {
    const nameless = res.skipped.filter(s => !s.kind);
    assert.deepStrictEqual(nameless, []);
  });
});

// --- 17: the mode is the operator's, and it is not spell-checked anywhere -

scenario('an unrecognised mode is refused outright, never silently dry-run', async () => {
  const d = deps({
    today: todayGrid([['', '', '', ''], ['', '', '', '']]),
    logs: new Map(),
    shadow: {},
  });
  let threw = null;
  try {
    await runPass({ branchId: 'b1', sheetId: 's1', date: '2026-09-17', mode: 'Write', deps: d });
  } catch (e) { threw = e; }
  check('it throws', () => assert.ok(threw, 'expected an unknown mode to be refused'));
  check('and names the mode it was given', () => assert.ok(/Write/.test(threw.message)));
  check('nothing was read before refusing', () => assert.ok(!d.calls.includes('readGrids')));
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
