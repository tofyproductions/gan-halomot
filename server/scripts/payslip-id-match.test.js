#!/usr/bin/env node
/**
 * ת"ז matching between a payslip PDF and an Employee record.
 *
 * Employee.israeli_id is stored left-padded to 9 digits (the pre-save hook in
 * models/Employee.js). The accountant's PDF prints the number the way the
 * payroll software holds it — commonly 8 digits with the leading zero dropped.
 * The audit controller used an exact-string findOne, so those payslips resolved
 * to no employee at all: not attributed, not distributable.
 *
 * This matters most for a payslip with NO salary-table row — an employee whose
 * employment ended and who was archived out of the month
 * (inactive_effective_month) still receives a final payslip, and the raw number
 * printed on the PDF is then the only identifier available.
 *
 *   node scripts/payslip-id-match.test.js
 */

const { padId9, payslipIdCandidates } = require('../src/controllers/payslipAudit.controller');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${name}`); return; }
  failures++;
  console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Does a payslip's printed ת"ז find an employee stored as `stored`? */
function matches(printedOnPayslip, stored) {
  return payslipIdCandidates(printedOnPayslip).includes(stored);
}

console.log('padId9 — mirrors the Employee pre-save normalisation');
{
  check('8 digits pad to 9', padId9('12345678') === '012345678');
  check('7 digits pad to 9', padId9('1234567') === '001234567');
  check('9 digits pass through', padId9('123456789') === '123456789');
  check('hyphens and spaces stripped before padding', padId9(' 12-345 678 ') === '012345678');
  check('empty stays empty', padId9('') === '' && padId9(null) === '' && padId9(undefined) === '');
  check('too short to be a ת"ז is not padded (invalid input stays visible)',
    padId9('123') === '123');
  check('longer than 9 passes through untouched', padId9('1234567890') === '1234567890');
}

console.log('\npayslip ת"ז → employee lookup');
{
  check('THE BUG: 8-digit number on the PDF finds the 9-digit stored employee',
    matches('12345678', '012345678'));

  check('identical 9-digit numbers still match',
    matches('123456789', '123456789'));

  check('hyphenated number on the PDF still matches',
    matches('12-345-678', '012345678'));

  check('a legacy row never re-saved (stored unpadded) is still reachable',
    matches('12345678', '12345678'));

  check('a different ת"ז does NOT match — padding must not merge two people',
    !matches('12345678', '087654321'));

  check('dropping a leading zero does not make two different people equal',
    !matches('012345678', '123456780'));

  check('no ת"ז on the payslip yields no candidates (never look up "everyone")',
    payslipIdCandidates('').length === 0
    && payslipIdCandidates(null).length === 0
    && payslipIdCandidates('   ').length === 0);

  check('candidates are de-duplicated when raw already equals padded',
    payslipIdCandidates('123456789').length === 1);
}

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll checks passed.');
