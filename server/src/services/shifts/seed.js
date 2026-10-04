/**
 * A new week, before the manager touches it: each employee where her
 * commitment says she works, for the hours it says.
 *
 * Area assignment precedence, per weekday: (1) the card says she is a
 * kitchen worker / floater (`shift_area`); (2) the card maps this weekday to
 * one of her two classes (`shift_day_classrooms`, active only); (3) her
 * active primary classroom; (4) the commitment's free-text `classroom` read
 * for kitchen/floater; (5) "unassigned", waiting for the manager to place her.
 */
function areaFromCommitmentText(text) {
  const t = String(text || '');
  if (/מטבח/.test(t)) return 'kitchen';
  if (/מחליפ/.test(t)) return 'floater';
  return null;
}

/** Where her card puts her on this weekday: { area, classroom_id }. */
function placementFor(emp, weekday, commitmentText, activeClassroomIds) {
  if (emp.shift_area === 'kitchen' || emp.shift_area === 'floater') return { area: emp.shift_area, classroom_id: null };
  const mapped = (emp.shift_day_classrooms || []).find(m => m.day === weekday);
  if (mapped && mapped.classroom_id && activeClassroomIds.has(String(mapped.classroom_id))) {
    return { area: 'class', classroom_id: String(mapped.classroom_id) };
  }
  if (emp.primary_classroom_id && activeClassroomIds.has(String(emp.primary_classroom_id))) {
    return { area: 'class', classroom_id: String(emp.primary_classroom_id) };
  }
  return { area: areaFromCommitmentText(commitmentText) || 'unassigned', classroom_id: null };
}

function buildSeedEntries({ dates, employees, commitments, activeClassroomIds, closedDates }) {
  // Required here, not at the top: rules.js requires this file for
  // areaFromCommitmentText, and a top-level require would load half of it.
  const { padHHMM } = require('./rules');
  const byEmployee = new Map(commitments.map(c => [String(c.employee_id), c]));
  const out = [];
  for (const emp of employees) {
    const c = byEmployee.get(String(emp._id));
    if (!c) continue;
    const days = [...(c.days || [])].sort((a, b) => a.day - b.day);
    const usual = days.find(d => !d.is_off && padHHMM(d.start_hhmm));
    for (const d of days) {
      // The import stores her alternating day as is_off; it is still a day she
      // works every other week, so it is seeded as work, flagged alternating.
      const alternating = !!(c.is_alternating_off && c.alternating_day === d.day);
      if (d.is_off && !alternating) continue;
      const date = dates[d.day];
      if (!date || closedDates.has(date)) continue;
      let start = padHHMM(d.start_hhmm);
      let end = padHHMM(d.end_hhmm);
      if (alternating && !start && !end && usual) {
        start = padHHMM(usual.start_hhmm);
        end = padHHMM(usual.end_hhmm);
      }
      const { area, classroom_id } = placementFor(emp, d.day, c.classroom, activeClassroomIds);
      out.push({
        employee_id: String(emp._id),
        employee_name: emp.full_name,
        date,
        area,
        classroom_id,
        start_hhmm: start,
        end_hhmm: end,
        alternating,
        new_class: false,
      });
    }
  }
  return out;
}

module.exports = { areaFromCommitmentText, placementFor, buildSeedEntries };
