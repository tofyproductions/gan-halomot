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

/**
 * What a מעון has to hold to operate. 'other' keeps the list from being a cage.
 *
 * The order is the order of the folder an inspector is handed: the licence
 * first, then the trades that have to sign off on the building, then the people
 * who have to sign off on the food and the hygiene, then the inspections.
 *
 * KEYS ARE PERMANENT. They are in the enum of every row ever written, so a
 * wording that turns out to be wrong is fixed in the label and never in the
 * key — `infrastructure` reads 'דוח התאמת תשתית לייעודה' because that is what
 * the document is actually called, and the key stays what it was.
 */
const CERT_TYPES = {
  operating_license: 'רישיון הפעלה',
  electrician: 'אישור חשמלאי',
  safety_inspector: 'אישור בודק בטיחות',
  fire_detection: 'אישור גילוי אש',
  gas_inspection: 'בדיקה תקופתית של מתקני הגז',
  equipment_inspection: 'בדיקת מתקנים',
  infrastructure: 'דוח התאמת תשתית לייעודה',
  nutritionist: 'אישור תזונאית',
  sanitarian: 'אישור תברואן',
  agronomist: 'אישור אגרונום (עצים)',
  criminal_registry: 'טפסי הסכמה למרשם הפלילי',
  inspection: 'ביקורת',
  other: 'אחר',
};

/**
 * What every עובדת has to hold. The screen is "קורסים והרשאות", and the second
 * word is why the consent form belongs here: it is a paper with her name on it
 * that the gan has to be able to produce, which is the same shape as a course
 * certificate and nothing like a branch's licence.
 */
const COURSE_TYPES = {
  first_aid: 'עזרה ראשונה (מד"א)',
  safe_conduct: 'התנהלות בטוחה',
  caregiver: 'קורס מטפלות',
  advanced_caregiver: 'קורס מטפלות מתקדמות',
  criminal_registry: 'הסכמה למרשם הפלילי',
  other: 'אחר',
};

/**
 * The course types that have an expiry at all.
 *
 * Was a literal `['first_aid', 'safe_conduct']` in four places — the
 * controller, the PDF report, and twice in the matrix screen. Four copies of
 * one fact is three chances to add a fifth type and have half the application
 * treat it as permanent.
 */
const EXPIRING_COURSE_TYPES = ['first_aid', 'safe_conduct'];

/**
 * What the licence actually requires of every עובדת, and therefore what the
 * coverage line on אישורי מעון counts. A course somebody took for herself is
 * welcome and is not a requirement.
 */
const REQUIRED_COURSE_TYPES = ['first_aid', 'safe_conduct', 'criminal_registry'];

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

module.exports = {
  WARN_DAYS, CERT_TYPES, COURSE_TYPES,
  EXPIRING_COURSE_TYPES, REQUIRED_COURSE_TYPES,
  statusOf, daysLeft,
};
