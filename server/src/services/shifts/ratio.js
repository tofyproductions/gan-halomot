/**
 * How many staff a class needs, and where the rota falls short.
 *
 * A warning, never a block: the day changes under the plan (children off sick,
 * children collected early) and the manager moves people during it. What the
 * board owes her is to show, while she plans, which class on which day is
 * below the ratio the licence asks for.
 */
const CATEGORY_KEY = { 'תינוקייה': 'infants', 'צעירים': 'young', 'בוגרים': 'older' };
const KFAR_SABA = { infants: 5, young: 7, older: 9 };
const OTHER = { infants: 5, young: 8, older: 10 };

function defaultRatios(branchName = '') {
  return String(branchName).trim().startsWith('כפר סבא') ? { ...KFAR_SABA } : { ...OTHER };
}

/** The city default, with any positive number the branch set replacing it. */
function effectiveRatios(branch) {
  const out = defaultRatios(branch && branch.name);
  const own = (branch && branch.staff_ratios) || {};
  for (const key of Object.keys(out)) {
    const v = Number(own[key]);
    if (Number.isFinite(v) && v > 0) out[key] = v;
  }
  return out;
}

function ratioWarnings({ entries, classrooms, dates, closedDates, ratios }) {
  const out = [];
  for (const date of dates) {
    if (closedDates.has(date)) continue;
    for (const room of classrooms) {
      const key = CATEGORY_KEY[room.category];
      if (!key || !(room.enrolled > 0)) continue;
      const staff = new Set(entries
        .filter(e => e.date === date && e.area === 'class' && String(e.classroom_id) === String(room._id))
        .map(e => String(e.employee_id))).size;
      const needed = Math.ceil(room.enrolled / ratios[key]);
      if (staff < needed) out.push({ date, classroom_id: String(room._id), enrolled: room.enrolled, staff, needed });
    }
  }
  return out;
}

module.exports = { CATEGORY_KEY, defaultRatios, effectiveRatios, ratioWarnings };
