#!/usr/bin/env node
/**
 * בונוס אוגוסט — the promises the math has to keep.
 *
 * The August bonus stopped being a one-click "pay everything" toggle and became
 * a per-day approval: the fixed summer window is the 16th through the 31st,
 * every day starts unapproved, and for a global (תקן) employee both the bonus
 * and the unapproved-day deduction are carved out of the remaining monthly
 * completion (never added beside it). Three promises follow, and each is a test
 * here because each is money:
 *
 *   1. Full approval pays EXACTLY the agreed salary — same total as a normal
 *      month, only the label moves from השלמת שכר to בונוס.
 *   2. An unapproved day genuinely reduces the month — the completion may not
 *      quietly top it back up.
 *   3. Nothing is ever paid twice: bonus + deduction + remaining completion
 *      can never exceed the completion they were carved from.
 *
 * Pure math only (services/augustBonus.js requires no database), so:
 *   node scripts/august-bonus.test.js
 */

const {
  augustBonusWindow, candidateDays, applyBonusSplit, bonusDayMinutes, sanitizeApprovedDates,
} = require('../src/services/augustBonus');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${name}`); return; }
  failures++;
  console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
}
const near = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------- window
console.log('augustBonusWindow — the window is a policy date, not a Holiday record');
{
  const w = augustBonusWindow('2026-08');
  check('August 2026 → 16–31', !!w && w.start === '2026-08-16' && w.end === '2026-08-31');
  check('July is not a bonus month', augustBonusWindow('2026-07') === null);
  check('September is not a bonus month', augustBonusWindow('2026-09') === null);
  check('garbage month is not a bonus month', augustBonusWindow('banana') === null && augustBonusWindow(null) === null);
}

// ---------------------------------------------------------------- candidates
console.log('candidateDays — committed weekdays inside 16–31, Saturdays never');
{
  // Sun–Thu 08:00–16:00, Friday off.
  const commitment = {
    days: [0, 1, 2, 3, 4].map(day => ({ day, is_off: false, start_hhmm: '08:00', end_hhmm: '16:00' })),
  };
  const days = candidateDays(commitment, '2026-08');
  // 16.8.2026 is a Sunday; 16–31 holds 16 calendar days = two full Sun–Thu
  // weeks (16–20, 23–27) plus Sun 30 + Mon 31.
  check('12 committed candidate days', days.length === 12, `got ${days.length}`);
  check('no Saturday sneaks in', days.every(d => d.weekday !== 6));
  check('no Friday (her day off) sneaks in', days.every(d => d.weekday !== 5));
  check('every day is inside the window', days.every(d => d.date >= '2026-08-16' && d.date <= '2026-08-31'));
  check('committed hours are 8', days.every(d => d.committed_hours === 8));

  const alternating = { ...commitment, is_alternating_off: true, alternating_day: 0 };
  const altDays = candidateDays(alternating, '2026-08');
  check('an alternating weekday is never a candidate (can\'t know which weeks)', altDays.every(d => d.weekday !== 0));

  check('no commitment → no candidates', candidateDays(null, '2026-08').length === 0);
  check('not August → no candidates', candidateDays(commitment, '2026-07').length === 0);
}

// ---------------------------------------------------------------- the split
console.log('applyBonusSplit — carve, never add');
{
  // Promise 1: full approval within the completion's capacity relabels money,
  // total unchanged (bonus + remaining completion === original completion).
  let r = applyBonusSplit({ completion: 5000, approvedValue: 3000, unapprovedValue: 0 });
  check('full approval: bonus is the approved value', r.bonus === 3000);
  check('full approval: deduction is zero', r.deduction === 0);
  check('full approval: completion covers the rest (1–15.8)', r.completion_after === 2000);
  check('full approval: total preserved exactly', near(r.bonus + r.completion_after, 5000));

  // Promise 1, harder: the days were priced generously (avg hours) above what
  // the completion can cover — the bonus is capped, total still exactly 100%.
  r = applyBonusSplit({ completion: 2000, approvedValue: 3000, unapprovedValue: 0 });
  check('overpriced days: bonus capped at the completion', r.bonus === 2000);
  check('overpriced days: nothing added beside the salary', near(r.bonus + r.completion_after, 2000));

  // Promise 2: no day approved → the whole closure value leaves the month.
  r = applyBonusSplit({ completion: 5000, approvedValue: 0, unapprovedValue: 3000 });
  check('none approved: no bonus', r.bonus === 0);
  check('none approved: the closure days are deducted', r.deduction === 3000);
  check('none approved: completion still covers the non-closure rest', r.completion_after === 2000);

  // Partial approval with scaling: both sides shrink together, and the carve
  // can never exceed what the completion held (promise 3).
  r = applyBonusSplit({ completion: 1000, approvedValue: 1500, unapprovedValue: 1500 });
  check('scaled: bonus and deduction shrink together', near(r.bonus, 500) && near(r.deduction, 500));
  check('scaled: completion is exactly used up, not overdrawn', r.completion_after === 0);
  check('scaled: carve never exceeds the completion', r.bonus + r.deduction <= 1000 + 0.02);

  // Plain partial: 2 of 3 same-priced days approved.
  r = applyBonusSplit({ completion: 5000, approvedValue: 800, unapprovedValue: 400 });
  check('partial: approved days become bonus', r.bonus === 800);
  check('partial: unapproved day reduces the month', r.deduction === 400);
  check('partial: the three parts sum back to the completion', near(r.bonus + r.deduction + r.completion_after, 5000));

  // Degenerate inputs must not explode or mint money.
  r = applyBonusSplit({ completion: 0, approvedValue: 1200, unapprovedValue: 300 });
  check('no completion capacity → nothing to carve, nothing paid or deducted', r.bonus === 0 && r.deduction === 0 && r.completion_after === 0);
  r = applyBonusSplit({ completion: -50, approvedValue: 100, unapprovedValue: 0 });
  check('negative completion treated as zero', r.bonus === 0 && r.completion_after === 0);
  r = applyBonusSplit({ completion: 5000, approvedValue: 0, unapprovedValue: 0 });
  check('no candidate days at all → completion untouched', r.bonus === 0 && r.deduction === 0 && r.completion_after === 5000);
}

// ---------------------------------------------------------------- day length
console.log('bonusDayMinutes — an hourly gift day is capped at 8h, never OT');
{
  check('hourly: 9h average is capped to 8h', bonusDayMinutes('hourly', 540, 480) === 480);
  check('hourly: 8.5h committed fallback is capped to 8h', bonusDayMinutes('hourly', null, 510) === 480);
  check('hourly: a 6h average stays 6h (cap is a ceiling, not a floor)', bonusDayMinutes('hourly', 360, 480) === 360);
  check('global: a 9h average stays 9h (the 100% salary cap protects the total)', bonusDayMinutes('global', 540, 480) === 540);
  check('average wins over commitment when present', bonusDayMinutes('global', 300, 480) === 300);
  check('no average → committed shift length', bonusDayMinutes('global', null, 480) === 480);
}

// ---------------------------------------------------------------- sanitation
console.log('sanitizeApprovedDates — the approval list is money; only clean dates enter');
{
  const out = sanitizeApprovedDates(['2026-08-20', 'DROP TABLE', '2026-08-16', '2026-08-20', 42, null, '2026-8-1']);
  check('junk filtered, duplicates dropped, sorted', JSON.stringify(out) === JSON.stringify(['2026-08-16', '2026-08-20']));
  check('non-array → empty list', sanitizeApprovedDates('2026-08-16').length === 0 && sanitizeApprovedDates(null).length === 0);
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll august-bonus checks passed.');
