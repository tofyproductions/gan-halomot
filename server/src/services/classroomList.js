/**
 * Which of a branch's rooms are the LIVE ones.
 *
 * "The current academic year" is a calendar fact (the cutoff is August 10);
 * which rooms a gan actually runs on is an operational one — a branch moves to
 * the new year's rooms when its manager opens them, not when the calendar
 * turns. In late August most branches still work on last year's rooms while
 * one has already opened next year's.
 *
 * Filtering by the calendar year hid entire branches (קפלן had no תשפ"ז rooms
 * yet, so every screen showed it roomless). Showing everything produced
 * year-duplicates ("קפלן — תינוקייה א" twice). The rule that matches reality:
 * per (branch, room name), keep only the NEWEST year's row.
 */
function dedupeNewest(rooms) {
  const byKey = new Map();
  for (const r of rooms) {
    const key = `${String(r.branch_id?._id || r.branch_id || '')}|${String(r.name || '').trim()}`;
    const prev = byKey.get(key);
    if (!prev || String(r.academic_year || '') > String(prev.academic_year || '')) {
      byKey.set(key, r);
    }
  }
  return [...byKey.values()];
}

module.exports = { dedupeNewest };
