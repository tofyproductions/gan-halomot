#!/usr/bin/env node
/**
 * בונוס / הבראה line-item extraction from the vendor's garbled-font PDF text.
 * Both labels never survive as plain Hebrew (same issue as meal/vehicle) —
 * confirmed against 19 real payslip pages from the same audit (2026-08,
 * הרצליה הרצוג). These are their exact garbled lines, byte for byte.
 *
 *   node scripts/pdf-bonus-recreation-extract.test.js
 */

const { findValueForLabel } = require('../src/services/payslipAudit/pdfParser');

const BONUS_GARBLED = '»º«º∏';
const RECREATION_GARBLED = 'ª∑–∏ª';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${name}`); return; }
  failures++;
  console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

console.log('findValueForLabel(BONUS_GARBLED) — real payslip lines');
{
  check('נגר גאולה, format B → 960',
    findValueForLabel('»º«º∏\t1.00\t960.00\t960.00', BONUS_GARBLED) === 960);
  check('אילנה שמחי, format B → 1844',
    findValueForLabel('»º«º∏\t1.00\t1,844.00\t1,844.00', BONUS_GARBLED) === 1844);
  check('עדן ימין, format A → 3917',
    findValueForLabel('3,917.00 3,917.00 1.00 »º«º∏', BONUS_GARBLED) === 3917);
  check('רוזה טרבלוס, format A → 2948',
    findValueForLabel('2,948.00 2,948.00 1.00 »º«º∏', BONUS_GARBLED) === 2948);
  check('קרן בן שבת, format A with a leading unrelated number → 4428 (not 4977)',
    findValueForLabel('4,977.00 4,428.00 4,428.00 1.00 »º«º∏', BONUS_GARBLED) === 4428);
  check('no בונוס line on page → null',
    findValueForLabel('“º…¿»«\t1.00\t64.00\t64.00', BONUS_GARBLED) === null);
}

console.log('findValueForLabel(RECREATION_GARBLED) — presence is what matters, not exact ₪');
{
  check('נגר גאולה, format A → a number found (82-ish)',
    findValueForLabel('82.00 82.09 1.00 ª∑–∏ª', RECREATION_GARBLED) != null);
  check('עדן ימין, format B → 359',
    findValueForLabel('ª∑–∏ª\t1.00\t359.00\t359.00', RECREATION_GARBLED) === 359);
  check('no הבראה line on page → null',
    findValueForLabel('“º…¿»«\t1.00\t64.00\t64.00', RECREATION_GARBLED) === null);
}

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll checks passed.');
