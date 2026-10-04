/**
 * אילוצים — the rules that need no database.
 *
 * The window is the gan's: constraints for next week close Thursday 18:00,
 * because the manager builds on Friday morning and must not be chasing
 * requests that arrive while she builds. Further-out weeks stay open — a
 * planned surgery a month away is exactly what she wants to know early.
 */
const { weekStart } = require('../parentVisibility');

const TYPES = ['day_off', 'partial', 'sick_expected', 'other', 'move_day', 'swap'];
const FINAL = new Set(['accepted', 'rejected', 'declined', 'cancelled']);
const ACTIONABLE = new Set(['open', 'pending_broadcast', 'broadcast']);
const DEADLINE_HOUR = 18;

function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split('T')[0];
}

function ilNow(now) {
  const copy = new Date(now);
  copy.setUTCHours(copy.getUTCHours() + 3); // UTC+3 (Israel EDT)
  const day = copy.toISOString().split('T')[0];
  const hour = copy.getUTCHours();
  return { day, hour };
}

function submissionWindow(dates, now) {
  const { day, hour } = ilNow(now);
  const current = weekStart(day);
  const next = addDays(current, 7);

  if (!dates || dates.length === 0) return { ok: true };

  const earliest = dates[0];
  const target = weekStart(earliest);

  if (target === next) {
    const thursday = addDays(current, 4);
    if (day > thursday || (day === thursday && hour >= DEADLINE_HOUR)) {
      return { ok: false, error: 'ההגשה לשבוע הבא נסגרה ביום חמישי ב-18:00' };
    }
  }
  return { ok: true };
}

/** A week after next or later — deciding it now is deciding early, and final. */
function isFarFuture(date, now) {
  const current = weekStart(ilNow(now).day);
  return weekStart(date) > addDays(current, 14);
}

const mins = (hhmm) => {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const overlaps = (s1, e1, s2, e2) => s1 !== null && e1 !== null && s2 !== null && e2 !== null && s1 < e2 && s2 < e1;
const on = (entries, empId, date) => entries.filter(e => String(e.employee_id) === String(empId) && e.date === date);

function respected(c, entries) {
  const me = String(c.employee_id);
  switch (c.type) {
    case 'day_off':
    case 'sick_expected':
      return on(entries, me, c.date).length === 0;
    case 'partial': {
      const s = mins(c.from_hhmm); const t = mins(c.to_hhmm);
      return !on(entries, me, c.date).some(e => overlaps(mins(e.start_hhmm), mins(e.end_hhmm), s, t));
    }
    case 'move_day':
      return on(entries, me, c.date).length === 0 && on(entries, me, c.target_date).length > 0;
    case 'swap': {
      if (!c.colleague_id) return false;
      const col = String(c.colleague_id);
      return on(entries, me, c.date).length === 0 && on(entries, col, c.date).length > 0 && on(entries, col, c.target_date).length === 0 && on(entries, me, c.target_date).length > 0;
    }
    default:
      return null;
  }
}

function blocksEntry(c, entry) {
  if (String(c.employee_id) !== String(entry.employee_id) || c.date !== entry.date) return false;
  if (c.type === 'partial') return overlaps(mins(entry.start_hhmm), mins(entry.end_hhmm), mins(c.from_hhmm), mins(c.to_hhmm));
  return ['day_off', 'sick_expected', 'move_day', 'swap'].includes(c.type);
}

module.exports = { TYPES, FINAL, ACTIONABLE, addDays, ilNow, submissionWindow, isFarFuture, respected, blocksEntry };
