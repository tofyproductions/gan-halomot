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

export function buildRows({ entries, classrooms }) {
  const rows = [
    ...classrooms.map(c => ({ key: `class:${c._id}`, label: c.name, area: 'class', classroom_id: String(c._id), cells: {} })),
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
