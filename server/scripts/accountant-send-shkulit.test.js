#!/usr/bin/env node
/**
 * "שלח לרו״ח" now carries the שקלולית import files, not just the cards.
 *
 * Two things here are about money rather than code:
 *
 *   1. The import files are built for the whole amuta at once (one company,
 *      600). A per-branch send would either drop them silently or mail the
 *      full amuta file once per branch — and a movements file imported twice
 *      pays the month twice. So a per-branch send is refused outright.
 *
 *   2. The download and the send must produce the SAME workbook. Two copies of
 *      the sheet layout would drift, and the drift would only ever surface as
 *      a wrong תלוש. Both now go through the exported builders, and this test
 *      pins the sheets those builders emit.
 *
 *   node scripts/accountant-send-shkulit.test.js
 *
 * Nothing leaves: email is stubbed and no database is touched.
 */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};

// Mail must not go anywhere from a test.
const mails = [];
const emailPath = require.resolve('../src/services/email.service');
require.cache[emailPath] = {
  id: emailPath, filename: emailPath, loaded: true, children: [], paths: [],
  exports: { dispatchEmail: async (m) => { mails.push(m); return { provider: 'test' }; } },
};

const assert = require('assert');
const XLSX = require('xlsx');
const { buildExportSource } = require('../src/services/payrollExport/sourceLayer');
const shkulit = require('../src/services/payrollExport/shkulitAdapter');

let passed = 0;
function ok(label) { console.log('  ✓ ' + label); passed++; }

function call(handler, { body = {}, params = {}, query = {}, user = { role: 'system_admin' } } = {}) {
  return new Promise((resolve, reject) => {
    const req = { user, body, params, query, headers: {} };
    const res = {
      statusCode: 200, headers: {},
      status(c) { this.statusCode = c; return this; },
      setHeader(k, v) { this.headers[k] = v; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); },
      send(b) { resolve({ status: this.statusCode, body: b, headers: this.headers }); },
    };
    Promise.resolve(handler(req, res, reject)).catch(reject);
  });
}

// A complete, valid hourly employee row, shaped like fetchMonthData(...).rows.
function validRow(over = {}) {
  return {
    employee_id: 'e1',
    full_name: 'רונית לוי',
    israeli_id: '312345678',
    employee_number: '1047',
    is_freelancer: false,
    is_active: true,
    salary_type: 'hourly',
    salary_is_net: false,
    branch_name: 'תל אביב',
    position: 'סייעת',
    bank_number: '10',
    bank_branch: '913',
    bank_account: '45012345',
    bank_account_holder: '',
    permanent_note: '',
    month: '2026-09',
    breakdown: {
      hours: { total: 176.5, regular: 170, ot_125: 6.5, ot_150: 0, days_worked: 22 },
      rates: { hourly_rate: 48.5 },
      components: {
        base_salary: 8560.25, travel: 352, recreation_monthly: 209,
        meal_vouchers: 0, bonuses: 0, closure_completion_bonus: 0,
        teken_breakdown: {},
      },
      deductions: { loans: 500, absence: 0 },
      estimated_total: 9121.25,
      warnings: [],
    },
    bonus: { effective: 300 },
    holiday_pay_auto: { total_pay: 0, total_days: 0 },
    sick_info: { pay: 0 },
    partial_absence: { deduction: 0, effective_hours: 0 },
    manual: {
      sick_days: 0, vacation_days: 1, holiday_pay: 0,
      gift_card: { kind: 'number', amount: 150 },
      cibus: { kind: 'empty' },
      miluim: { kind: 'empty' },
      advance_deduction_text: '', notes: '',
      include_salary_completion: true,
    },
    status: 'draft',
    payslip_paid: false,
    ...over,
  };
}

(async () => {
  const C = require('../src/controllers/payrollMonth.controller');

  console.log('the branch gate — one send, all the gans');
  {
    const res = await call(C.sendToAccountant, {
      params: { month: '2026-09' },
      query: { branch: 'branch-1' },
      body: { emails: ['acct@example.com'] },
    });
    assert.strictEqual(res.status, 409, 'a per-branch send must be refused');
    assert.strictEqual(res.body.branch_scoped, true);
    assert.ok(/כל הגנים/.test(res.body.error), 'the refusal says what to do instead');
    ok('a send scoped to one branch is refused, and says why');

    // The refusal must happen BEFORE anything is dispatched — a 409 that still
    // mails half a month would be worse than no gate at all.
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(mails.length, 0, 'nothing may be dispatched on a refused send');
    ok('a refused send dispatches no email at all');
  }

  console.log('the month rejects a bad shape before the branch gate');
  {
    const res = await call(C.sendToAccountant, {
      params: { month: 'nonsense' },
      query: { branch: 'branch-1' },
    });
    assert.strictEqual(res.status, 400);
    ok('a malformed month is still a 400, not a branch complaint');
  }

  console.log('the movements workbook — what the accountant imports');
  {
    const source = buildExportSource('2026-09', [
      validRow(),
      validRow({ employee_id: 'e2', full_name: 'דנה כהן', employee_number: '1048' }),
    ]);
    const wb = C.shkulitMovementsWorkbook(source, '2026-09');
    assert.strictEqual(wb.baseName, 'נתוני שכר לחודש 2026-09');
    const read = XLSX.read(wb.buffer, { type: 'buffer' });
    assert.deepStrictEqual(read.SheetNames, ['נתוני שכר', 'הוראות והערות']);
    ok('two sheets: the movements themselves and the notes beside them');

    assert.ok(wb.rows.length > 0, 'two valid employees must produce movement rows');
    ok('valid employees produce movement rows');
  }

  console.log('a failed employee never disappears quietly');
  {
    // Failed for a reason that still blocks — no employee number, so there is
    // nobody in שקלולית to attach her rows to. (This used to be a missing bank
    // account; since 30.09.2026 that is a warning, pinned in the next block.)
    const source = buildExportSource('2026-09', [
      validRow(),
      validRow({ employee_id: 'e2', full_name: 'דנה כהן', employee_number: '' }),
    ]);
    assert.strictEqual(source.failed.length, 1);
    assert.strictEqual(source.failed[0].full_name, 'דנה כהן');
    // The send reads exactly this list to build the red block in the email
    // body. If it were empty, an accountant could import a short file believing
    // it whole — which is a person who does not get paid.
    assert.ok((source.failed[0].errors || []).length > 0, 'the failure carries a readable reason');
    ok('an employee who cannot be filed is reported by name, with a reason');
  }

  console.log('a missing bank account never disappears quietly either');
  {
    // She is FILED now — the movements file carries no bank field, and holding
    // her out made שקלולית carry her previous payslip forward (גאליה כהן:
    // August's 9.6 hours shown for a September she worked 108.6). But the
    // accountant must still key the account before the transfer, so it has to
    // reach the file and the master has to leave her out rather than send the
    // bank columns blank over whatever שקלולית already holds.
    const source = buildExportSource('2026-09', [
      validRow(),
      validRow({ employee_id: 'e2', full_name: 'דנה כהן', employee_number: '1048', bank_account: '' }),
    ]);
    assert.strictEqual(source.failed.length, 0, 'not a failure');
    assert.ok(source.ready.some((ce) => ce.employee.full_name === 'דנה כהן'), 'she is in the file');

    const { rows, notes } = shkulit.buildMovements(source, new Map(), {});
    assert.ok(rows.some((r) => String(r[1]) === '1048'), 'her salary rows are in the movements file');
    const note = notes.find((n) => String(n.employee_number) === '1048' && n.subject === 'חסר חשבון בנק');
    assert.ok(note, 'and the missing account is a note in the same file');

    const master = shkulit.buildMaster(source);
    assert.ok(!master.rows.some((r) => String(r[1]) === '1048'), 'the master leaves her out — no blank bank columns');
    assert.ok(master.held_back.some((h) => String(h.employee_number) === '1048'), 'and says it held her back');
    ok('filed, noted in the file, and held out of the master until the account exists');
  }

  console.log('the master workbook — issued on change, never blank');
  {
    const master = {
      header: ['מספר עובד', 'שם'],
      rows: [['1047', 'רונית לוי']],
    };
    const changed = C.shkulitMasterWorkbook(master, {
      new: [{ employee_number: '1048', full_name: 'דנה כהן' }],
      changed: [{ employee_number: '1047', full_name: 'רונית לוי', changes: [{ column: 'בנק', before: '10', after: '12' }] }],
    }, '2026-09');
    assert.strictEqual(changed.baseName, 'נתוני עובד 2026-09');
    const readChanged = XLSX.read(changed.buffer, { type: 'buffer' });
    assert.deepStrictEqual(readChanged.SheetNames, ['נתוני עובד', 'שינויים מאז הקובץ הקודם']);
    const changeSheet = XLSX.utils.sheet_to_json(
      readChanged.Sheets['שינויים מאז הקובץ הקודם'], { header: 1 },
    );
    assert.ok(changeSheet.some(r => String(r[1]) === 'דנה כהן' && /חדש/.test(String(r[2]))),
      'a new employee is named as new');
    assert.ok(changeSheet.some(r => /בנק/.test(String(r[2])) && /12/.test(String(r[2]))),
      'a changed field shows before and after');
    ok('the change sheet names the new employee and the changed field');

    // An empty change sheet with only a header reads as "the file is broken".
    // It has to say, in words, that there is nothing to re-key.
    const none = C.shkulitMasterWorkbook(master, { new: [], changed: [] }, '2026-09');
    const readNone = XLSX.read(none.buffer, { type: 'buffer' });
    const noneSheet = XLSX.utils.sheet_to_json(
      readNone.Sheets['שינויים מאז הקובץ הקודם'], { header: 1 },
    );
    assert.ok(noneSheet.some(r => /אין שינויים/.test(String(r[2] || ''))),
      'no changes is stated out loud, not left blank');
    ok('no changes since the last file says so in words');
  }

  console.log(`\nAll accountant-send שקלולית tests passed (${passed} checks).`);
  process.exit(0);
})().catch(err => {
  console.error('\nFAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
