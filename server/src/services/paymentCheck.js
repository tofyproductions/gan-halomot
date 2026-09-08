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

/**
 * "לא רלוונטי" is the vendor's dropdown for a family that pays through
 * somebody else — and it is NOT a payment method. Read as `other` it would sit
 * in the queue as a value nobody has to do anything about; read as `none` it
 * joins the families whose method was never decided, which is what it is.
 *
 * BOTH SPELLINGS. Hebrew writes the word with a ו and with a ב and the office
 * types whichever it types; a spelling this list does not know reads as `other`
 * and carries "לא רלבנטי" into the table as though it were a payment method
 * somebody chose.
 */
const NOT_APPLICABLE = ['לא רלוונטי', 'לא רלבנטי'];

/**
 * The methods, in the order they are tested — which is the order of how
 * specific each rule is, not alphabetical.
 *
 * WHY THE ORDER IS PART OF THE RULE. The vendor writes free text, and a family
 * writes more than one word in it: "מזומן / העברה בנקאית" is a family paying
 * partly in cash, and it must read as cash rather than as a transfer, so cash
 * is tested first. "הוראת קבע באשראי" is a standing order, so the standing
 * order is tested before the card. Everything below that cannot collide.
 *
 * The hints are matched against the NORMALISED value (quotes and dashes gone),
 * which is why 'צק' catches צ'ק, צ׳ק and צ״ק in one entry.
 */
const METHOD_RULES = [
  { kind: 'cash', label: 'מזומן', hints: [CASH] },
  {
    kind: 'standing_order',
    label: 'הוראת קבע',
    hints: [...STANDING_ORDER_HINTS, 'הרשאה לחיוב', 'הרשאה'],
  },
  { kind: 'credit_card', label: 'כרטיס אשראי', hints: ['אשראי', 'כרטיס'] },
  { kind: 'cheque', label: "צ'ק", hints: ['שיק', 'צק', 'המחאה'] },
  { kind: 'bank_transfer', label: 'העברה בנקאית', hints: ['העברה'] },
];

/** kind -> the short name the screens and the workbook print. */
const KIND_LABELS = {
  ...Object.fromEntries(METHOD_RULES.map(r => [r.kind, r.label])),
  none: 'לא הוגדר',
  other: 'אחר',
};

/**
 * Which payment method this is — the vendor's free text, named.
 *
 * SEPARATE FROM THE ALERT ON PURPOSE. `paymentAlert` answers "does the office
 * have to do something about this family", and for most families the answer is
 * no; this answers "how does this family pay", which the office wants to see
 * for every row at a glance. Colouring a whole column by kind is what turns
 * sixty free-text cells into something readable, and it is the reason the two
 * questions are now two functions rather than one.
 *
 * An unrecognised label keeps its own text as the label: `other` is not a
 * complaint, it is "the vendor wrote something we have not seen", and hiding
 * what that something was would make the next label change invisible.
 */
function classifyPaymentMethod(raw) {
  const method = normalizeMethod(raw);
  if (!method || NOT_APPLICABLE.some(v => method.includes(v))) {
    return { kind: 'none', label: KIND_LABELS.none };
  }
  const hit = METHOD_RULES.find(r => r.hints.some(h => method.includes(h)));
  if (hit) return { kind: hit.kind, label: hit.label };
  // The raw value, trimmed — not KIND_LABELS.other. See above.
  return { kind: 'other', label: String(raw ?? '').trim() };
}

const LABELS = {
  cash: 'מזומן — לא מתקבל',
  missing: 'לא הוגדר אמצעי תשלום לשכ"ל',
  incomplete: 'הוראת קבע ללא פרטי בנק',
  cheque: 'צ\'ק — מומלץ לעבור להו"ק',
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
 * TWO SEVERITIES, BECAUSE THE OWNER ASKED TWO DIFFERENT QUESTIONS OF THIS
 * LIST. Cash, a missing method and a הו"ק without a bank stop the money: they
 * are `error` and they are the number on the card. A cheque is accepted and
 * always was — the gan would rather have a הו"ק, which is a nudge and not a
 * refusal — so it is `warning`, counted separately, and it must never inflate
 * the "לטיפול" number into a list nobody trusts. A bank transfer raises
 * nothing at all: it is a method the gan accepts, full stop.
 *
 * CALLERS MUST PASS THE STANDING ORDER. Recomputing this from a query that
 * excluded standing_order would report every הו"ק family as incomplete — see
 * the select() in externalEnrollment.controller#list and in
 * tmtApproval.controller#buildReconciliation, both of which now read the
 * sub-document and strip it before the response.
 */
function paymentAlert(enrollment, standingOrder) {
  const { kind } = classifyPaymentMethod(enrollment?.tuition_method);
  if (kind === 'none') return { code: 'missing', label: LABELS.missing, severity: 'error' };
  if (kind === 'cash') return { code: 'cash', label: LABELS.cash, severity: 'error' };
  if (kind === 'standing_order') {
    const bank = normalizeMethod(standingOrder?.bank);
    const account = normalizeMethod(standingOrder?.account);
    if (!bank || !account) {
      return { code: 'incomplete', label: LABELS.incomplete, severity: 'error' };
    }
  }
  if (kind === 'cheque') return { code: 'cheque', label: LABELS.cheque, severity: 'warning' };
  return null;
}

/**
 * The alert for a stored ExternalEnrollment row, sources rule included.
 *
 * A row that has only ever been in the CONTRACTS export has no payment method
 * because that file has no payment column — not because the family failed to
 * choose one. Flagging it as `missing` would put a family on the chase list
 * over a file nobody uploaded yet, and it would say the wrong thing twice: the
 * screen already marks that row "חסר פרטי הורים", which is the accurate
 * complaint and names the actual fix (upload the registrations export).
 *
 * The `sources`-less rows predate the contracts export entirely and were all
 * registrations rows — the same reading `sourcesOf` applies in the controller.
 */
function paymentAlertFor(doc) {
  if (!fromRegistrations(doc)) return null;
  return paymentAlert(doc?.enrollment, doc?.standing_order);
}

/** Has this row ever been in the registrations export — the only file with a payment column. */
function fromRegistrations(doc) {
  const sources = Array.isArray(doc?.sources) ? doc.sources.filter(Boolean) : [];
  return (sources.length ? sources : ['registrations']).includes('registrations');
}

/**
 * The payment-method chip for a stored row, or null when there is no chip to
 * show at all.
 *
 * Same sources rule as `paymentAlertFor`, and for the same reason: a row that
 * has only ever been in the contracts export has no payment column behind it,
 * and painting it "לא הוגדר" would state as a fact about the family something
 * that is only a fact about which file has been uploaded.
 */
function paymentMethodFor(doc) {
  if (!fromRegistrations(doc)) return null;
  return classifyPaymentMethod(doc?.enrollment?.tuition_method);
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

module.exports = {
  paymentAlert, paymentAlertFor, paymentMethodCounts, normalizeMethod, LABELS,
  classifyPaymentMethod, paymentMethodFor, KIND_LABELS,
};
