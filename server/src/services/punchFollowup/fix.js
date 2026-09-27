'use strict';

/**
 * Punch follow-up — the pure helpers behind the employee's fixes and her
 * morning push (stage 2 of docs/superpowers/specs/2026-09-27-punch-followup-design.md).
 * No database here; the controller and the morning job feed plain objects in.
 */

const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

/** 'YYYY-MM-DD' → 'יום ראשון 27.9' — how a person reads a day in a push. */
function dayLabel(ymd) {
  const d = new Date(`${ymd}T12:00:00Z`);
  return `יום ${DAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()}.${d.getUTCMonth() + 1}`;
}

/**
 * Which side of a one-punch day is missing. The clock's own direction wins
 * when it gave one (0 = entry, 1 = exit); TIMEDOX often sends 255 (it does
 * not know), and then the day is ordered by time like everywhere else.
 */
function missingSide(existing, hhmm) {
  if (existing.state === 0) return 'out';
  if (existing.state === 1) return 'in';
  return hhmm > existing.hhmm ? 'out' : 'in';
}

const ROLES = new Set(['in', 'out', 'ignore']);

/**
 * An employee's labelling of a duplicate day: every counted punch of that day
 * exactly once, only in / out / ignore, and entries pairing with exits. Returns
 * the Hebrew reason it is refused, or null.
 */
function validateLabels(labels, dayPunchIds) {
  if (!Array.isArray(labels) || !labels.length) return 'יש לסמן את כל ההחתמות של היום';
  const want = new Set(dayPunchIds.map(String));
  const seen = new Set();
  let ins = 0;
  let outs = 0;
  for (const l of labels) {
    const id = String(l?.punch_id || '');
    if (!want.has(id)) return 'סומנה החתמה שאינה שייכת ליום הזה';
    if (seen.has(id)) return 'אותה החתמה סומנה פעמיים';
    if (!ROLES.has(l.role)) return 'סימון לא מוכר';
    seen.add(id);
    if (l.role === 'in') ins += 1;
    if (l.role === 'out') outs += 1;
  }
  if (seen.size !== want.size) return 'יש לסמן את כל ההחתמות של היום';
  if (ins === 0 || ins !== outs) return 'כל כניסה צריכה יציאה מתאימה';
  return null;
}

/**
 * The morning push list: per employee, the issues that became hers
 * yesterday — open for her to fix, she has an app login, never pushed before.
 * Older open issues are NOT re-pushed: the popup is the repeating reminder.
 */
function pickEmployeePushes(issues, sentKeys, yesterday) {
  const out = new Map();
  for (const i of issues) {
    if (i.visibility?.employee !== 'fix' || !i.has_user) continue;
    if (i.date !== yesterday || sentKeys.has(i.key)) continue;
    if (!out.has(i.employee_id)) out.set(i.employee_id, []);
    out.get(i.employee_id).push(i);
  }
  return out;
}

const KIND_TITLE = {
  missing: (d) => `חסרה לך החתמה ב${d}`,
  duplicate: (d) => `יש לך החתמה כפולה ב${d}`,
  empty_day: (d) => `לא נמצאו החתמות ב${d}`,
};

/** One push per employee: named when it is one day, a count when several. */
function pushText(issues) {
  if (issues.length === 1) {
    const i = issues[0];
    return { title: KIND_TITLE[i.kind](dayLabel(i.date)), body: 'לחצי כאן לתיקון' };
  }
  return { title: `יש לך ${issues.length} ימים לתיקון בהחתמות`, body: 'לחצי כאן לתיקון' };
}

module.exports = { dayLabel, missingSide, validateLabels, pickEmployeePushes, pushText };
