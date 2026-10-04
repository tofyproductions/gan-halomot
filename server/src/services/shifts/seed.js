/**
 * A new week, before the manager touches it: each employee where her
 * commitment says she works, for the hours it says.
 *
 * Area assignment precedence: (1) employee's active primary classroom (if set
 * and active); (2) the commitment's free-text `classroom` interpreted for
 * kitchen/floater (תינוקייה / מטבח / מחליפה …) only if no primary class is
 * active; (3) "unassigned" if neither applies, waiting for the manager to
 * place her.
 */
function areaFromCommitmentText(text) {
  const t = String(text || '');
  if (/מטבח/.test(t)) return 'kitchen';
  if (/מחליפ/.test(t)) return 'floater';
  return null;
}

function buildSeedEntries({ dates, employees, commitments, activeClassroomIds, closedDates }) {
  const byEmployee = new Map(commitments.map(c => [String(c.employee_id), c]));
  const out = [];
  for (const emp of employees) {
    const c = byEmployee.get(String(emp._id));
    if (!c) continue;
    const textArea = areaFromCommitmentText(c.classroom);
    const primary = emp.primary_classroom_id && activeClassroomIds.has(String(emp.primary_classroom_id))
      ? String(emp.primary_classroom_id) : null;
    const area = primary ? 'class' : (textArea || 'unassigned');
    const days = [...(c.days || [])].sort((a, b) => a.day - b.day);
    for (const d of days) {
      if (d.is_off) continue;
      const date = dates[d.day];
      if (!date || closedDates.has(date)) continue;
      out.push({
        employee_id: String(emp._id),
        employee_name: emp.full_name,
        date,
        area,
        classroom_id: area === 'class' ? primary : null,
        start_hhmm: d.start_hhmm || '',
        end_hhmm: d.end_hhmm || '',
        alternating: !!(c.is_alternating_off && c.alternating_day === d.day),
        new_class: false,
      });
    }
  }
  return out;
}

module.exports = { areaFromCommitmentText, buildSeedEntries };
