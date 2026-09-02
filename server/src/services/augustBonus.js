/**
 * "בונוס אוגוסט" — the pure math, with no database in sight.
 *
 * The office's decision (2026-09-02): the summer-vacation days an employee can
 * be paid a bonus for are FIXED — the 16th through the 31st of August. Not the
 * branch's Holiday(kind:'closure') record; the record was wrong once and the
 * policy is a date, so the date lives here. Days 1–15 stay ordinary payroll:
 * the standing monthly completion covers them and never these.
 *
 * Every day in the window starts UNAPPROVED. The accountant approves days one
 * by one (or all at once) in the edit dialog; only approved days are
 * materialized as punches and paid. An approved day is a gift day the gan
 * grants — it must never draw from the vacation balance (the caller excludes
 * the window from vacation-day accrual when the flag is on).
 *
 * applyBonusSplit is the no-double-pay guarantee for a global (תקן) employee:
 * the bonus and the unapproved-day deduction are both carved out of the
 * remaining monthly completion, never added beside it. Full approval therefore
 * lands on exactly 100% of her salary — the same total a normal month pays —
 * with the closure share merely relabeled from "השלמת שכר" to "בונוס".
 *
 * This file must stay require-able without mongoose so the test script can
 * exercise the math directly (scripts/august-bonus.test.js).
 */

const WINDOW_START_DAY = 16;

/** The fixed summer-vacation window, or null for any month that isn't August. */
function augustBonusWindow(month) {
  if (!/^\d{4}-08$/.test(month || '')) return null;
  return { start: `${month}-${WINDOW_START_DAY}`, end: `${month}-31` };
}

/** Weekday 0=Sun..6=Sat of a 'YYYY-MM-DD' string (timezone-free by construction). */
function weekdayOfDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** 'HH:MM' → fractional hours. */
function hhmmToHours(hhmm) {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return h + m / 60;
}

/**
 * What the commitment says about one weekday: { start_hhmm, end_hhmm }, or
 * null (no commitment / day off / an alternating day — we can't know which
 * specific weeks she's committed on, so it is never a bonus candidate).
 */
function committedHoursForWeekday(commitment, weekday) {
  if (!commitment) return null;
  if (commitment.is_alternating_off && commitment.alternating_day === weekday) return null;
  const day = (commitment.days || []).find(d => d.day === weekday);
  if (!day || day.is_off) return null;
  if (!day.start_hhmm || !day.end_hhmm) return null;
  return { start_hhmm: day.start_hhmm, end_hhmm: day.end_hhmm };
}

/**
 * Every committed weekday inside the August window — the full candidate list
 * the dialog shows and approval acts on. Saturdays never; a day she actually
 * worked is filtered out by the CALLER (it needs her punches to know).
 */
function candidateDays(commitment, month) {
  const window = augustBonusWindow(month);
  if (!window) return [];
  const out = [];
  for (let dayNum = WINDOW_START_DAY; dayNum <= 31; dayNum++) {
    const date = `${month}-${String(dayNum).padStart(2, '0')}`;
    const weekday = weekdayOfDate(date);
    if (weekday === 6) continue; // Saturday — never a work day
    const hours = committedHoursForWeekday(commitment, weekday);
    if (!hours) continue;
    out.push({
      date,
      weekday,
      start_hhmm: hours.start_hhmm,
      end_hhmm: hours.end_hhmm,
      committed_hours: Math.round(Math.max(0, hhmmToHours(hours.end_hhmm) - hhmmToHours(hours.start_hhmm)) * 100) / 100,
    });
  }
  return out;
}

/**
 * Carve the bonus (approved days) and the unapproved-day deduction out of the
 * remaining monthly completion of a global employee.
 *
 * Both are scaled down together when their combined value exceeds what the
 * completion can cover — the bonus can only RELABEL completion money, never
 * add beside it, so:
 *   - every day approved   → total pay is exactly the agreed salary (100%);
 *   - no day approved      → total pay is the salary minus the closure days;
 *   - partial              → linearly in between.
 */
function applyBonusSplit({ completion, approvedValue, unapprovedValue }) {
  const C = Math.max(0, Number(completion) || 0);
  const a = Math.max(0, Number(approvedValue) || 0);
  const u = Math.max(0, Number(unapprovedValue) || 0);
  const total = a + u;
  const scale = (total > C && total > 0) ? C / total : 1;
  const bonus = Math.round(a * scale * 100) / 100;
  const deduction = Math.round(u * scale * 100) / 100;
  const completion_after = Math.max(0, Math.round((C - bonus - deduction) * 100) / 100);
  return { bonus, deduction, completion_after, scale };
}

/** Sanitize a client-sent approved-dates array: valid YYYY-MM-DD, unique, sorted. */
function sanitizeApprovedDates(arr) {
  if (!Array.isArray(arr)) return [];
  return [...new Set(arr.filter(s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)))].sort();
}

module.exports = {
  augustBonusWindow,
  weekdayOfDate,
  hhmmToHours,
  committedHoursForWeekday,
  candidateDays,
  applyBonusSplit,
  sanitizeApprovedDates,
};
