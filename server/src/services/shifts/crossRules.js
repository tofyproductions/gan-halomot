/**
 * סניפים אחרים — rules that need no database.
 */
const { weekdayOf } = require('../fixedSchedule');

const mins = (hhmm) => {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** A rate the payroll can actually pay her at that branch. */
function hasBranchRate(employee, branchId) {
  return (employee.branch_rates || []).some(r => String(r.branch_id) === String(branchId)
    && ((Number(r.hourly_rate) || 0) > 0 || (Number(r.global_salary) || 0) > 0));
}

const placementKey = (e) => `${e.employee_id}|${e.date}|${e.start_hhmm || ''}|${e.end_hhmm || ''}`;

/** One person, two branches, the same minutes — refused. Back-to-back is the normal switch. */
function crossOverlaps(entries, otherEntries) {
  const out = [];
  for (const e of entries) {
    const s = mins(e.start_hhmm); const t = mins(e.end_hhmm);
    if (s === null || t === null) continue;
    const hit = otherEntries.find(o => String(o.employee_id) === String(e.employee_id) && o.date === e.date
      && mins(o.start_hhmm) !== null && mins(o.end_hhmm) !== null && s < mins(o.end_hhmm) && mins(o.start_hhmm) < t);
    if (hit) out.push({ employee_id: String(e.employee_id), employee_name: e.employee_name, date: e.date, other_branch_id: String(hit.branch_id) });
  }
  return out;
}

function arrangementCovers(arr, entry) {
  return String(arr.employee_id) === String(entry.employee_id)
    && arr.weekday === weekdayOf(entry.date)
    && arr.start_hhmm === entry.start_hhmm && arr.end_hhmm === entry.end_hhmm;
}

/** Her day in the rota as one span, at the branch she starts in. */
function rotaDay(entries, date) {
  const day = entries.filter(e => e.date === date && mins(e.start_hhmm) !== null && mins(e.end_hhmm) !== null)
    .sort((a, b) => mins(a.start_hhmm) - mins(b.start_hhmm));
  if (!day.length) return null;
  const end = day.reduce((m, e) => (mins(e.end_hhmm) > mins(m) ? e.end_hhmm : m), day[0].end_hhmm);
  return { in: day[0].start_hhmm, out: end, branch_id: day[0].branch_id ? String(day[0].branch_id) : null };
}

function lateness(firstPunch, scheduledStart, threshold = 30) {
  if (mins(scheduledStart) === null) return null;
  if (!firstPunch) return { kind: 'absent' };
  const diff = mins(firstPunch) - mins(scheduledStart);
  return diff > threshold ? { kind: 'late', minutes: diff } : null;
}

module.exports = { hasBranchRate, placementKey, crossOverlaps, arrangementCovers, rotaDay, lateness };
