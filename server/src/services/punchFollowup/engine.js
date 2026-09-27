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

const COUNTED = new Set(['auto', 'approved']);
const AT_MANAGER = new Set(['pending', 'pending_manager']);

function eachDay(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

const dayKey = (empId, date) => `${empId}|${date}`;

/** Group a list by employee|day. */
function byEmpDay(list, dateField) {
  const m = new Map();
  for (const x of list) {
    const k = dayKey(String(x.employee_id), x[dateField]);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

/**
 * Where a day's own reports put it. A report the manager has not seen yet →
 * pending_manager; one she approved (now with the accountant) → handled.
 * Rejected reports are gone, so a rejection falls back to open by itself.
 */
function stateFromReports(pending) {
  if (pending.some(p => p.approval_status === 'pending_accountant')) return 'handled';
  if (pending.some(p => AT_MANAGER.has(p.approval_status))) return 'pending_manager';
  return null;
}

/**
 * Every problem day in the window, per employee, with where it stands:
 * open (nobody touched it) · pending_manager (the employee answered, the
 * manager hasn't) · handled (the manager approved — it is the accountant's
 * now, and neither the employee nor the manager is asked about it again).
 */
function buildIssues(input) {
  const { window, employees } = input;
  if (!window) return [];
  const punchesByDay = byEmpDay((input.punches || []).filter(p => p.approval_status !== 'rejected'), 'day');
  const resolutionByDay = new Map((input.resolutions || []).map(r => [dayKey(String(r.employee_id), r.date), r]));
  const issues = [];
  const days = eachDay(window.from, window.to);

  for (const e of employees) {
    if (e.is_active === false || e.receives_salary === false) continue;
    const empId = String(e.id);
    for (const date of days) {
      if (e.start_date && date < e.start_date) continue;
      const dayPunches = punchesByDay.get(dayKey(empId, date)) || [];
      const counted = dayPunches.filter(p => COUNTED.has(p.approval_status || 'auto'));
      const pending = dayPunches.filter(p => !COUNTED.has(p.approval_status || 'auto'));
      const kind = classifyDayCount(counted.length);
      const push = (k, state) => issues.push({
        key: `${empId}|${date}|${k}`, employee_id: empId, branch_id: e.branch_id ? String(e.branch_id) : null,
        date, kind: k, state,
      });

      if (kind === 'missing') {
        push('missing', stateFromReports(pending) || 'open');
      } else if (kind === 'duplicate') {
        const r = resolutionByDay.get(dayKey(empId, date));
        if (r && r.status === 'approved') continue;
        push('duplicate', r?.status === 'pending' ? 'handled'
          : r?.status === 'pending_manager' ? 'pending_manager' : 'open');
      }
    }
  }
  return issues;
}

module.exports = { classifyDayCount, addDays, followupWindow, buildIssues };
