/**
 * אמצעי התשלום של המשפחה — מה שצריך טיפול לפני שהילד/ה מתחיל/ה.
 *
 * The owner's rule is short: cash is not accepted, and a family whose payment
 * method was never set up has to be chased. Both facts are already in the
 * ClickTac registrations export — `צורת תשלום שכ"ל` and the four הו"ק columns
 * — and both were being parsed, stored, and then read by nobody. So a family
 * paying in cash and a family with no method at all looked exactly like a
 * family on a credit card, and the first anyone found out was in October.
 *
 * WHY A FILE OF ITS OWN. This is a business rule about the vendor's free text,
 * not about the file format, and it is asked in three places (at import, in
 * the review queue, and in the תמ"ת comparison). One pure function, no
 * database, no mongoose — which is also what makes it testable without a
 * server (scripts/payment-check.test.js).
 *
 * THE STRINGS ARE THE VENDOR'S AND THEY ARE NOT A CONTRACT. ClickTac writes
 * whatever the form's dropdown says, and nobody here controls that wording: it
 * has been seen as כרטיס אשראי and as הוראת קבע, but הו"ק / הו״ק / הוראת-קבע
 * are all shapes the same field can take, and a future label change is a
 * matter of when. So the match is on a NORMALISED substring rather than on
 * equality with a list of known values, and an unrecognised method is not an
 * alert — inventing a problem out of a label we have not seen yet would put
 * the office on a phone call it does not need to make. The distinct raw values
 * are counted and returned alongside the alerts (`payment_methods` in the list
 * and reconcile responses) precisely so the office can see what the vendor
 * actually writes, and this file can be corrected from evidence.
 */

/**
 * Quote marks, in every shape a Hebrew form produces.
 *
 * הו"ק with an ASCII double quote, הו״ק with a gershayim (U+05F4), הו׳ק with a
 * geresh (U+05F3), and whatever a copy-paste out of Word turns those into.
 * Stripped rather than translated, so all of them normalise to the same הוק.
 */
const QUOTES = /["'׳״‘’“”`´]/g;

/** Hyphens and dashes, so הוראת-קבע reads as הוראת קבע. */
const DASHES = /[-־‐-―]/g;

/**
 * Trim, strip quotes and dashes, collapse runs of whitespace.
 *
 * Deliberately NOT lower-cased or transliterated: the values are Hebrew, and
 * the two things that actually vary in the wild are the quote glyph and the
 * spacing around it.
 */
function normalizeMethod(value) {
  return String(value ?? '')
    .replace(QUOTES, '')
    .replace(DASHES, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const CASH = 'מזומן';

/** What the family called a standing order, once normalised. */
const STANDING_ORDER_HINTS = ['הוראת קבע', 'הוראתקבע', 'הוק'];

const LABELS = {
  cash: 'מזומן — לא מתקבל',
  missing: 'לא הוגדר אמצעי תשלום לשכ"ל',
  incomplete: 'הוראת קבע ללא פרטי בנק',
};

/**
 * The one alert this family raises, or null.
 *
 * `enrollment` is the ExternalEnrollment's enrollment sub-document (only
 * `tuition_method` is read) and `standingOrder` is its standing_order.
 *
 * ORDER MATTERS, AND IT IS THE ORDER OF THE PROBLEM'S SIZE. A blank method is
 * checked first because it is the only one where nothing was decided at all; a
 * method that mentions cash is refused whatever else it also mentions, since a
 * family paying half in cash is still paying in cash.
 *
 * A standing order is only INCOMPLETE, never wrong: the family chose a method
 * the gan accepts and the bank details did not come through — which is a phone
 * call to the family, not a change of method. Both the bank code and the
 * account number are required, because a הו"ק cannot be filed with either one
 * missing.
 *
 * CALLERS MUST PASS THE STANDING ORDER. Recomputing this from a query that
 * excluded standing_order would report every הו"ק family as incomplete — see
 * the select() in externalEnrollment.controller#list and in
 * tmtApproval.controller#buildReconciliation, both of which now read the
 * sub-document and strip it before the response.
 */
function paymentAlert(enrollment, standingOrder) {
  const method = normalizeMethod(enrollment?.tuition_method);
  if (!method) return { code: 'missing', label: LABELS.missing };
  if (method.includes(CASH)) return { code: 'cash', label: LABELS.cash };
  if (STANDING_ORDER_HINTS.some(h => method.includes(h))) {
    const bank = normalizeMethod(standingOrder?.bank);
    const account = normalizeMethod(standingOrder?.account);
    if (!bank || !account) return { code: 'incomplete', label: LABELS.incomplete };
  }
  return null;
}

/**
 * What the vendor actually writes, counted.
 *
 * The empty string is a value like any other here — "how many families have no
 * method at all" is the number the office wants first, and dropping it would
 * hide it. Sorted by count so the two or three real values sit at the top and
 * the typos below them.
 */
function paymentMethodCounts(docs = []) {
  const counts = new Map();
  for (const d of docs) {
    const value = String(d?.enrollment?.tuition_method ?? '').trim();
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, 'he'));
}

module.exports = { paymentAlert, paymentMethodCounts, normalizeMethod, LABELS };
