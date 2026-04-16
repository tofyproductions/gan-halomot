/**
 * Classroom color scheme — consistent across Dashboard, CollectionsTable,
 * and any future component that needs to distinguish classrooms.
 *
 * Color mapping (per user request):
 *   בוגרים   = dark blue    (#1e40af / #dbeafe)
 *   צעירים   = light blue   (#3b82f6 / #e0f2fe)
 *   תינוקייה = light cyan   (#06b6d4 / #ecfeff)
 *
 * Falls back to a neutral gray for unrecognized names.
 */

const CLASS_COLORS = [
  { match: /בוגרים/,   label: 'בוגרים',   primary: '#1e40af', bg: '#dbeafe', border: '#93c5fd' },
  { match: /צעירים/,   label: 'צעירים',   primary: '#60a5fa', bg: '#eff6ff', border: '#bfdbfe' },
  { match: /תינוק/,    label: 'תינוקייה', primary: '#06b6d4', bg: '#ecfeff', border: '#67e8f9' },
];
const DEFAULT_COLOR = { primary: '#64748b', bg: '#f1f5f9', border: '#cbd5e1' };

export function getClassroomColor(classroomName) {
  if (!classroomName) return DEFAULT_COLOR;
  const name = String(classroomName);
  for (const c of CLASS_COLORS) {
    if (c.match.test(name)) return c;
  }
  return DEFAULT_COLOR;
}
