'use strict';

/**
 * Punch follow-up — the PURE engine (stage 1 of
 * docs/superpowers/specs/2026-09-27-punch-followup-design.md).
 *
 * No database here. The loader hands in plain objects; the engine decides
 * which employee-days are problems, where each one stands, and who sees it.
 * The "one counted punch = missing, more than two = duplicate" rule lives here
 * and punchIssues (the accountant's screen) calls it too — two copies of that
 * rule is how the employee's popup and the payroll screen would start to
 * disagree about the same day.
 */

/** 1 counted punch → missing; more than 2 → duplicate; 0 and 2 → nothing. */
function classifyDayCount(n) {
  if (n === 1) return 'missing';
  if (n > 2) return 'duplicate';
  return null;
}

/** Calendar arithmetic on 'YYYY-MM-DD', at noon UTC so DST never shifts the day. */
function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function firstOfPreviousMonth(ymd) {
  const d = new Date(`${ymd.slice(0, 7)}-01T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * The days the follow-up looks at: from the start of the previous month (so
 * the 1st of a month still sees yesterday) or the go-live date, whichever is
 * later, up to yesterday. No go-live date = the flow is off.
 */
function followupWindow(today, startDate) {
  if (!startDate) return null;
  const to = addDays(today, -1);
  const prev = firstOfPreviousMonth(today);
  const from = startDate > prev ? startDate : prev;
  return from > to ? null : { from, to };
}

module.exports = { classifyDayCount, addDays, followupWindow };
