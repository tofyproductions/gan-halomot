const { weekDates } = require('../parentVisibility');
const { areaFromCommitmentText } = require('./seed');

/** Sunday to Friday of the week starting `weekStart`. */
function weekDays(weekStart) {
  return weekDates(weekStart).slice(0, 6);
}

/**
 * The gan year a date belongs to, 'YYYY-YYYY+1', September to August — the
 * same shape Classroom.academic_year is stored in. Last year's classes stay
 * is_active (their children too) until somebody archives them, so the rota
 * picks the year from the week, not from what happens to be active.
 */
function schoolYearOf(ymd) {
  const m = /^(\d{4})-(\d{2})/.exec(String(ymd || ''));
  if (!m) return null;
  const start = Number(m[2]) >= 9 ? Number(m[1]) : Number(m[1]) - 1;
  return `${start}-${start + 1}`;
}

function isSunday(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd))) return false;
  return new Date(`${ymd}T12:00:00.000Z`).getUTCDay() === 0;
}

/**
 * Hours as the rota stores them: always 'HH:MM'. The commitments import keeps
 * whatever the sheet had ('7:00'), so every way into a week goes through here;
 * anything that is not a real time of day becomes blank rather than garbage.
 */
function padHHMM(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v == null ? '' : v).trim());
  if (!m) return '';
  const h = Number(m[1]); const min = Number(m[2]);
  if (h > 23 || min > 59) return '';
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

const minutes = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/**
 * One person cannot be in two rooms at once. Back-to-back (13:00 out, 13:00
 * in) is the normal mid-day switch and is allowed; any real overlap is not.
 */
function findOverlaps(entries) {
  const groups = new Map();
  for (const e of entries) {
    const s = minutes(e.start_hhmm); const t = minutes(e.end_hhmm);
    if (s === null || t === null) continue;
    const key = `${e.employee_id}|${e.date}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ s, t, e });
  }
  const out = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.s - b.s);
    for (let i = 1; i < list.length; i += 1) {
      if (list[i].s < list[i - 1].t) {
        const { employee_id, employee_name, date } = list[i].e;
        out.push({ employee_id: String(employee_id), employee_name, date });
        break;
      }
    }
  }
  return out;
}

/** What one employee's week looks like, independent of entry ids and order. */
function signatures(entries) {
  const map = new Map();
  for (const e of entries || []) {
    const id = String(e.employee_id);
    if (!map.has(id)) map.set(id, []);
    map.get(id).push([e.date, e.area, e.classroom_id ? String(e.classroom_id) : '', e.start_hhmm || '', e.end_hhmm || ''].join('|'));
  }
  for (const [id, list] of map) map.set(id, list.sort().join(';'));
  return map;
}

/** Employees whose own entries differ between two snapshots (added, changed or removed). */
function affectedEmployeeIds(prev, next) {
  const a = signatures(prev); const b = signatures(next);
  const out = new Set();
  for (const id of new Set([...a.keys(), ...b.keys()])) if (a.get(id) !== b.get(id)) out.add(id);
  return out;
}

function suggestPrimary({ commitmentText, classrooms }) {
  const text = String(commitmentText || '').trim();
  const all = classrooms.map(r => String(r._id));
  const exact = classrooms.find(r => r.name === text);
  if (exact) return { suggestion: String(exact._id), candidates: [String(exact._id)] };
  const sameCategory = classrooms.filter(r => r.category && r.category === text).map(r => String(r._id));
  if (sameCategory.length === 1) return { suggestion: sameCategory[0], candidates: sameCategory };
  if (sameCategory.length > 1) return { suggestion: null, candidates: sameCategory };
  return { suggestion: null, candidates: all };
}

/** A class employee with a commitment and no primary class. Kitchen and floaters have no class to ask about. */
function needsPrimaryPrompt(employee, commitment) {
  if (!commitment || employee.primary_classroom_id || employee.shift_area) return false;
  return areaFromCommitmentText(commitment.classroom) === null;
}

module.exports = { schoolYearOf, weekDays, isSunday, padHHMM, findOverlaps, affectedEmployeeIds, suggestPrimary, needsPrimaryPrompt };
