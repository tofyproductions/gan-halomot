/**
 * תוקף — the one question this whole area answers: is this paper still good,
 * and if not, how loudly should the screen say so.
 *
 * Shared by the branch-certification and employee-course controllers, the
 * daily digest and the tests, so "expiring soon" means the same thing in the
 * table, in the mail and on the badge. A document with no date at all is its
 * own state, not "fine": a רישיון הפעלה without an expiry is a row somebody
 * has not finished filling in.
 */

/** How far ahead "עוד מעט פג" looks. Two months is what renewing actually takes
 *  when the renewal is a course with a waiting list or an inspector's visit. */
const WARN_DAYS = 60;

/** What a מעון has to hold to operate. 'other' keeps the list from being a cage. */
const CERT_TYPES = {
  operating_license: 'רישיון הפעלה',
  electrician: 'אישור חשמלאי',
  fire_detection: 'אישור גילוי אש',
  equipment_inspection: 'בדיקת מתקנים',
  infrastructure: 'טופס התאמת תשתית',
  agronomist: 'אישור אגרונום (עצים)',
  inspection: 'ביקורת',
  other: 'אחר',
};

/** What every עובדת has to hold. The first two expire; the courses do not. */
const COURSE_TYPES = {
  first_aid: 'עזרה ראשונה (מד"א)',
  safe_conduct: 'התנהלות בטוחה',
  caregiver: 'קורס מטפלות',
  advanced_caregiver: 'קורס מטפלות מתקדמות',
  other: 'אחר',
};

/**
 * 'expired' | 'expiring' | 'ok' | 'no_expiry'
 *
 * Day-granular on purpose: a certificate is valid THROUGH its printed date,
 * so it turns 'expired' the day after, not at the midnight before.
 */
function statusOf(expiresAt, now = new Date(), warnDays = WARN_DAYS) {
  if (!expiresAt) return 'no_expiry';
  const exp = new Date(expiresAt);
  if (Number.isNaN(exp.getTime())) return 'no_expiry';
  const endOfDay = new Date(exp.getFullYear(), exp.getMonth(), exp.getDate(), 23, 59, 59, 999);
  if (endOfDay < now) return 'expired';
  if (endOfDay.getTime() - now.getTime() <= warnDays * 86400000) return 'expiring';
  return 'ok';
}

/** Days until the printed date, negative once it has passed. For "בעוד 12 יום". */
function daysLeft(expiresAt, now = new Date()) {
  if (!expiresAt) return null;
  const exp = new Date(expiresAt);
  if (Number.isNaN(exp.getTime())) return null;
  return Math.ceil((exp.getTime() - now.getTime()) / 86400000);
}

module.exports = { WARN_DAYS, CERT_TYPES, COURSE_TYPES, statusOf, daysLeft };
