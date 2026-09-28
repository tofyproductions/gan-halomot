#!/usr/bin/env node
/**
 * The month table must not reference a name that lives in another function.
 *
 * On 28.09.2026 the row builder reached for `vacUse`, a variable belonging to
 * buildAccountantHtml. Node does not complain at load time; the ReferenceError
 * only fires when the line actually runs, and that line was inside
 * `if (opening.as_of_month)` — so it threw for exactly the employees who had an
 * opening vacation balance.
 *
 * Nobody had one. Every test passed, the deploy went out, and the whole salary
 * table broke the moment the balances were imported — for every branch at once,
 * with "שגיאה בטעינת טבלת שכר" and nothing else to go on.
 *
 * This is the cheap check that would have caught it: the row builder's source,
 * read as text, must not name anything defined only inside the card builder.
 *
 *   node scripts/payroll-month-scope.test.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

let passed = 0;
const ok = (label) => { console.log('  ✓ ' + label); passed += 1; };

const file = path.join(__dirname, '..', 'src', 'controllers', 'payrollMonth.controller.js');
const src = fs.readFileSync(file, 'utf8');

const ROW_MAP = 'const rows = employees.map(emp => {';
const CARD = 'function buildAccountantHtml';
const rowStart = src.indexOf(ROW_MAP);
const cardStart = src.indexOf(CARD);
assert.ok(rowStart > -1, 'the row builder must still be findable');
assert.ok(cardStart > rowStart, 'the card builder must still come after it');

const rowMap = src.slice(rowStart, cardStart);
const cardBody = src.slice(cardStart);

console.log('the row builder cannot borrow the card builder\'s variables');
{
  // Deliberately NOT a general scope analysis. A broad scan flags every `n`,
  // `type` and `open` declared in some nested callback and cries wolf until
  // somebody deletes the test. What is checked here is the small set of names
  // that are DISTINCTIVE to buildAccountantHtml — the ones a copy-paste from
  // the card into the row would actually drag along.
  const CARD_ONLY = ['vacUse', 'vacTaken', 'vacAvail', 'tekenFactor', 'augBonus', 'sickVal', 'paDed', 'paExtra'];
  const leaked = CARD_ONLY.filter((name) => {
    const declaredHere = new RegExp(`\\b(?:const|let)\\s+${name}\\b`).test(rowMap);
    const usedHere = new RegExp(`\\b${name}\\b`).test(rowMap);
    const inCard = new RegExp(`\\b(?:const|let)\\s+${name}\\b`).test(cardBody);
    return usedHere && !declaredHere && inCard;
  });
  assert.deepStrictEqual(leaked, [],
    `the row builder references names that only exist in buildAccountantHtml: ${leaked.join(', ')}`);
  ok('no distinctive card-builder name is used inside the row builder');
}

console.log('the vacation balance block is self-contained');
{
  // The specific shape that broke: the balance payload must take its usage from
  // a variable the row builder itself declares.
  assert.ok(/const vacUseRow = vacationUsageForMonth\(/.test(rowMap),
    'the row builder computes its own vacation usage');
  assert.ok(!/\bvacUse\b(?!Row)/.test(rowMap),
    'and never reaches for the card builder\'s vacUse');
  ok('the row builder computes vacation usage itself, under its own name');
}

console.log(`\nAll payroll-month scope tests passed (${passed} checks).`);
