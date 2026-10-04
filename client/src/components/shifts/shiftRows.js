/**
 * Entries → the rows the board, the printout and the employee screen all draw.
 *
 * One function for all three, so the paper and the screen cannot disagree
 * about which row somebody is in — the same lesson the punch grid learned.
 */
export const HEB_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי'];
export const AREA_ROWS = [
  { key: 'kitchen', label: 'מטבח' },
  { key: 'floater', label: 'מחליפות' },
  { key: 'unassigned', label: 'ללא כיתה' },
];

export const rowKeyOf = (e) => (e.area === 'class' ? `class:${e.classroom_id}` : e.area);

export function fmtDate(ymd) {
  const [, m, d] = String(ymd).split('-');
  return `${d}/${m}`;
}

export const toMin = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? (+m[1]) * 60 + (+m[2]) : null;
};
export const fmtMin = (min) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;

/** A stable hue per employee, so her chips look the same every week. */
export function employeeHue(id) {
  let h = 0;
  const s = String(id);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

/** Scheduled minutes per employee per date — only entries with valid hours. */
export function scheduledMinutes(entries) {
  const out = new Map(); // id -> Map(date -> minutes)
  for (const e of entries || []) {
    const a = toMin(e.start_hhmm); const b = toMin(e.end_hhmm);
    if (a == null || b == null || b <= a) continue;
    const id = String(e.employee_id);
    if (!out.has(id)) out.set(id, new Map());
    const byDate = out.get(id);
    byDate.set(e.date, (byDate.get(e.date) || 0) + (b - a));
  }
  return out;
}

/**
 * Minutes scheduled beyond the commitment, per day and per employee — what the
 * week pays on top of the contracted hours. Foreign (cross-branch) people are
 * skipped: their pay runs through the rate request. Alternating days are
 * skipped too — the commitment marks them off even though she works them
 * every other week.
 */
export function overtimeOf({ entries, employees, dates }) {
  const empOf = new Map((employees || []).map(e => [String(e._id), e]));
  const own = (entries || []).filter((e) => {
    const emp = empOf.get(String(e.employee_id));
    return emp && !emp.foreign && !e.alternating;
  });
  const sched = scheduledMinutes(own);
  const perDay = Object.fromEntries(dates.map(d => [d, 0]));
  const perEmp = [];
  let total = 0;
  for (const [id, byDate] of sched) {
    const emp = empOf.get(id);
    const days = [];
    let empTotal = 0;
    for (const [date, minutes] of byDate) {
      const weekday = dates.indexOf(date);
      const c = (emp.commitment || {})[weekday];
      const committed = c ? Math.max(0, (toMin(c.end_hhmm) ?? 0) - (toMin(c.start_hhmm) ?? 0)) : 0;
      const extra = minutes - committed;
      if (extra <= 0) continue;
      days.push({ date, weekday, extra, committed, scheduled: minutes });
      perDay[date] += extra;
      empTotal += extra;
    }
    if (!empTotal) continue;
    days.sort((a, b) => a.date.localeCompare(b.date));
    perEmp.push({ employee_id: id, full_name: emp.full_name, days, total: empTotal });
    total += empTotal;
  }
  perEmp.sort((a, b) => b.total - a.total);
  return { perDay, perEmp, total };
}

export function buildRows({ entries, classrooms }) {
  const rows = [
    ...classrooms.map(c => ({ key: `class:${c._id}`, label: c.name, enrolled: c.enrolled, category: c.category, area: 'class', classroom_id: String(c._id), cells: {} })),
    ...AREA_ROWS.map(a => ({ key: a.key, label: a.label, area: a.key, classroom_id: null, cells: {} })),
  ];
  const byKey = new Map(rows.map(r => [r.key, r]));
  for (const e of entries || []) {
    let row = byKey.get(rowKeyOf({ ...e, classroom_id: e.classroom_id ? String(e.classroom_id) : null }));
    // A class closed after the entry was made: keep the person visible.
    if (!row) row = byKey.get('unassigned');
    (row.cells[e.date] = row.cells[e.date] || []).push(e);
  }
  for (const r of rows) for (const d of Object.keys(r.cells)) r.cells[d].sort((a, b) => String(a.start_hhmm).localeCompare(String(b.start_hhmm)));
  return rows.filter(r => r.key !== 'unassigned' || Object.keys(r.cells).length > 0);
}

/** `${employee_id}|${date}` for every person who changes rooms during a day. */
export function switchedSet(entries) {
  const rowsByKey = new Map();
  for (const e of entries || []) {
    const k = `${e.employee_id}|${e.date}`;
    if (!rowsByKey.has(k)) rowsByKey.set(k, new Set());
    rowsByKey.get(k).add(rowKeyOf({ ...e, classroom_id: e.classroom_id ? String(e.classroom_id) : null }));
  }
  return new Set([...rowsByKey].filter(([, s]) => s.size > 1).map(([k]) => k));
}

/** Her people placed in other branches this week — shown for information, never exported or clickable. */
export function buildAwayRow(away) {
  const cells = {};
  for (const e of away || []) {
    (cells[e.date] = cells[e.date] || []).push({ ...e, employee_name: `${e.employee_name} (${e.branch_name})` });
  }
  for (const d of Object.keys(cells)) cells[d].sort((a, b) => String(a.start_hhmm).localeCompare(String(b.start_hhmm)));
  return { key: 'away', label: 'בסניפים אחרים', area: 'away', classroom_id: null, cells };
}
