#!/usr/bin/env node
/**
 * The payslip-audit "בונוס" row must equal what the real payslip prints as
 * one line — the personal hourly-branch bonus PLUS August's closure-completion
 * bonus. They're computed and approved separately in-system (different
 * screens, different approval steps) but land on the same payslip line, so
 * the audit has to sum them or a fully-approved closure bonus still reads as
 * a mismatch against the real payslip (real incident: נגר גאולה, 2026-08 —
 * ₪960 closure bonus approved and paid, audit showed בונוס: 0).
 *
 *   node scripts/payslip-audit-bonus.test.js
 */

const { systemRowToTableRow } = require('../src/controllers/payslipAudit.controller');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${name}`); return; }
  failures++;
  console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

function baseRow(overrides = {}) {
  return {
    salary_type: 'hourly',
    breakdown: { hours: {}, rates: {}, components: {}, deductions: {}, estimated_total: 0 },
    bonus: { effective: 0 },
    manual: {},
    ...overrides,
  };
}

function bonusDetail(row) {
  return systemRowToTableRow(row).system_detail.find((d) => d.label === 'בונוס');
}

console.log('systemRowToTableRow — בונוס sums personal bonus + closure-completion bonus');
{
  const closureOnly = baseRow({
    bonus: { effective: 0 },
    breakdown: { hours: {}, rates: {}, components: { closure_completion_bonus: { amount: 960 } }, deductions: {}, estimated_total: 960 },
  });
  check('closure bonus alone → 960 (was 0 before the fix)', bonusDetail(closureOnly)?.value === 960);
  check('top-level bonus field matches (gap-comparison reads this one)', systemRowToTableRow(closureOnly).bonus === 960);

  const personalOnly = baseRow({ bonus: { effective: 250 } });
  check('personal bonus alone → 250', bonusDetail(personalOnly)?.value === 250);

  const both = baseRow({
    bonus: { effective: 250 },
    breakdown: { hours: {}, rates: {}, components: { closure_completion_bonus: { amount: 960 } }, deductions: {}, estimated_total: 1210 },
  });
  check('both present → 1210 (no double-count, no overwrite)', bonusDetail(both)?.value === 1210);

  const neither = baseRow();
  check('neither present → 0, row still shown', bonusDetail(neither)?.value === 0);
}

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll checks passed.');
