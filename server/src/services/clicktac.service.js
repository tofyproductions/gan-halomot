/**
 * Reading קליקטאק's exports — BOTH of them.
 *
 * The vendor's portal offers two downloads and neither one is the whole story:
 *
 *   the registrations export — child, BOTH parents, phones, emails, the
 *                              payment method and the הו"ק details. Fifty
 *                              columns. No class, no subsidy tier.
 *   the contracts export     — one row per signed contract: the class the
 *                              child was put in, the funding type, the subsidy
 *                              tier (דרגה) and the contract dates. Twenty-six
 *                              columns, and not one parent among them.
 *
 * The office needs both halves, so both go through the same upload button and
 * the header row decides which file this is (detectExportType). Each half
 * merges into the same row per child; neither overwrites the other's fields.
 *
 * The column names are Hebrew and they are the vendor's, not ours — they will
 * change when ClickTac changes a label, and when they do the fix has to be one
 * line in a map rather than a hunt through parsing code. Everything this file
 * knows about either file's shape is in COLUMNS / CONTRACT_COLUMNS.
 *
 * Two things are deliberately NOT read from either file:
 *
 *   the branch  — `מוסד` says "כפר סבא" on every row and there are two
 *                 branches in Kfar Saba. It is passed in at import.
 *   the class   — the age group is computed here and compared with ClickTac's,
 *                 never silently overwritten. (The contracts export's `כיתה`
 *                 is the vendor's own class NAME and is stored as a fact about
 *                 the contract, not used as a placement.)
 */

const { normalizeYear } = require('./academic-year.service');
const { stableHash } = require('../utils/stable-hash');
const { paymentAlert } = require('./paymentCheck');

/** Vendor column -> what it means. The whole file-format contract. */
const COLUMNS = {
  institution: 'מוסד',
  year: 'שנת לימודים',
  portal: 'פורטל',

  child_first: 'שם פרטי של הנרשם',
  child_last: 'שם משפחה של הנרשם',
  child_id: 'ת.ז הנרשם',
  birth_date: 'תאריך לידה',
  age_group: 'שכבת גיל',
  gender: 'מגדר',
  health_fund: 'קופת חולים',
  allergy: 'אלרגיה',
  allergy_detail: 'פירוט אלרגיה',
  aide_name: 'שם של מלווה',
  aide_phone: 'טלפון של מלווה',
  welfare: 'מופנה על ידי המחלקה לשירותים חברתיים',

  p1_first: 'שם פרטי של הרושם הראשון',
  p1_last: 'שם משפחה של הרושם הראשון',
  p1_id: 'מספר זהות של הרושם הראשון',
  p1_relation: 'קירבה של הרושם הראשון',
  p1_marital: 'מעמד אישי של הרושם הראשון',
  p1_address: 'כתובת של הרושם הראשון',
  p1_phone: 'טלפון של הרושם הראשון',
  p1_email: 'אימייל של הרושם הראשון',
  p1_occupation: 'עיסוק של הרושם הראשון',
  p1_self_employed: 'האם הרושם הראשון עוסק',

  p2_first: 'שם פרטי של הרושם השני',
  p2_last: 'שם משפחה של הרושם השני',
  p2_id: 'מספר זהות של הרושם השני',
  p2_relation: 'קירבה של הרושם השני',
  p2_marital: 'מעמד אישי של הרושם השני',
  p2_address: 'כתובת של הרושם השני',
  p2_phone: 'טלפון של הרושם השני',
  p2_email: 'אימייל של הרושם השני',
  p2_occupation: 'עיסוק של הרושם השני',
  p2_self_employed: 'האם הרושם השני עוסק',

  status: 'סטטוס',
  continuing: 'ממשיך',
  second_signer: 'חותם שני',
  registered_at: 'תאריך הרשמה',
  receipt: 'מספר קבלה',
  reg_fee_method: 'צורת תשלום דמי רישום',
  reg_fee_card: 'פרטי כרטיס אשראי דמי רישום',
  tuition_method: 'צורת תשלום שכ"ל',
  tuition_card: 'פרטי כרטיס אשראי שכר לימוד',
  voucher: 'מספר שובר',
  amount: 'סכום תשלום',

  so_bank: 'הו"ק - קוד בנק',
  so_branch: 'הו"ק - סניף',
  so_account: 'הו"ק - חשבון',
  so_holder: 'הו"ק - שם בעל חשבון',
};

/**
 * The contracts export — contracts_export_<digits>.xlsx, sheet "Worksheet 1".
 *
 * Twenty-six columns, one row per contract. What it has that the registrations
 * export does not: `כיתה` (the class the child was actually put in), `דרגה`
 * (the subsidy tier the whole fee depends on) and the contract's start/end.
 * What it does not have at all: parents, phones, emails, payment method, bank
 * details. Which is why a row that has only ever been in THIS file cannot be
 * turned into a registration — see the promotion guard in the controller.
 *
 * `מעון` is the institution as the vendor writes it and is NOT the branch, for
 * the same reason `מוסד` is not in the registrations export: two branches in
 * Kfar Saba answer to one name. The branch is chosen at upload, as it always
 * was.
 *
 * `שכר לימוד` is a funding TYPE — "מימון משרד הכלכלה", not an amount. Reading
 * it as a number would put a zero fee on every child in the file.
 */
const CONTRACT_COLUMNS = {
  contract_id: 'Id',
  child_first: 'שם פרטי',
  child_last: 'שם משפחה',
  nickname: 'כינוי',
  birth_date: 'תאריך לידה',
  birth_date_hebrew: 'תאריך לידה עברי',
  id_type: 'סוג מספר זהות',
  id_number: 'ת.ז. או דרכון',
  health_fund: 'קופת חולים',
  medical_notes: 'הערות רפואיות',
  registered_at: 'תאריך הרשמה',
  status: 'סטטוס',
  age_group: 'שכבת גיל',
  admin_notes: 'הערות הנהלה',
  institution: 'מעון',
  year: 'שנת לימודים',
  class_name: 'כיתה',
  tuition_type: 'שכר לימוד',
  tier: 'דרגה',
  start_date: 'תאריך התחלה',
  end_date: 'תאריך סיום',
  tags: 'תגיות',
  created_by: 'יוצר',
  created_at: 'תאריך יצירה',
  updated_by: 'מעדכן',
  updated_at: 'תאריך עדכון',

  /**
   * THE SEPTEMBER 2026 SHAPE. Some time between the export the parser above
   * was written against (26 columns) and the one uploaded on 09.09.2026 (72
   * columns), the vendor widened this file to carry the family as well: both
   * parents, address, the per-child balance, "ממשיך משנה קודמת" and the actual
   * tuition amount. Every column below is OPTIONAL — a file without them still
   * parses exactly as before — and `missingContractColumns` does not require
   * any of them, so an older export is not refused.
   *
   * What this changes downstream: a row that has only ever been in the
   * contracts export is no longer parentless by construction. See `hasParents`
   * in the controller.
   */
  p1_first: 'שם פרטי הורה ראשון',
  p1_last: 'שם משפחה הורה ראשון',
  p1_phone: 'טלפון הורה ראשון',
  p1_email: 'אימייל הורה ראשון',
  p1_id: 'ת.ז. הורה ראשון',
  p2_first: 'שם פרטי הורה שני',
  p2_last: 'שם משפחה הורה שני',
  p2_phone: 'טלפון הורה שני',
  p2_email: 'אימייל הורה שני',
  p2_id: 'ת.ז. הורה שני',
  home_phone: 'טלפון בבית',
  address: 'כתובת 1',
  city: 'עיר',
  // מאזן — the child's own account. NEGATIVE IS A DEBT: "-4539" on a child
  // whose fee is 3102 is the registration fee and a first month not yet paid.
  // `יתרה להתאמה` is the same number without its sign and is not stored.
  // `מאזן כללי` is the family's — two siblings show the same figure.
  balance: 'מאזן',
  family_balance: 'מאזן כללי',
  deposit: 'פיקדון',
  continuing: 'ממשיך משנה קודמת',
  // The sum, as opposed to `שכר לימוד` which is the funding type.
  tuition_amount: 'סכום שכר לימוד',
  extended_funding: 'מימון ממשלתי מורחב',
  card_last4: 'ארבע ספרות אחרונות',
  terminal_type: 'סוג מסוף סליקה',
  charge_day: 'יום גביה',
};

/**
 * Does this file's `מעון` belong to the branch the upload was aimed at?
 *
 * WHY THIS EXISTS. The contracts export the vendor now publishes is for the
 * WHOLE ORGANISATION — 155 rows across three institutions in one sheet — and
 * on 09.09.2026 it was uploaded against הרצליה as if it were הרצליה's. The
 * cross-branch guard caught the 72 children who were already filed elsewhere;
 * the 18 who were not yet in the system anywhere were created under הרצליה
 * with תל אביב's classes. So the column is read after all — not to CHOOSE the
 * branch (it still cannot separate the two כפר סבא gans, see the note on
 * CONTRACT_COLUMNS) but to REFUSE a row that plainly belongs to another city.
 *
 * The match is by the leading words: the vendor writes "הרצליה", "כפר סבא",
 * "תל אביב יפו - אייזיק חריף"; the branches are "הרצליה הרצוג", "כפר סבא -
 * משה דיין", "כפר סבא - קפלן", "תל אביב". One side starting with the other's
 * first word(s) is the test, so both כפר סבא branches accept "כפר סבא" and
 * nothing else does.
 *
 * A blank `מעון` is accepted: an older export has no such column at all, and
 * silence is not evidence of another branch.
 */
function institutionMatchesBranch(institution, branchName) {
  const inst = str(institution);
  if (!inst) return true;
  const norm = (s) => str(s).replace(/[-–—]/g, ' ').replace(/\s+/g, ' ').trim();
  const a = norm(inst);
  const b = norm(branchName);
  if (!a || !b) return true;
  // The city is the first word — or the first two, for a two-word city. Take
  // the shorter of the two names' leading words and demand the other begins
  // with them.
  const words = (s) => s.split(' ').filter(Boolean);
  const wa = words(a);
  const wb = words(b);
  const startsWith = (long, short) => short.every((w, i) => long[i] === w);
  // Two words when the first is a common two-word city prefix (כפר, תל, בית,
  // ראש…), otherwise one. Both names are compared at the same depth.
  const depth = /^(כפר|תל|בית|ראש|רמת|קרית|גבעת|בני|באר|פתח|נס|הוד)$/.test(wa[0]) ? 2 : 1;
  return startsWith(wa, wb.slice(0, depth)) || startsWith(wb, wa.slice(0, depth));
}

/**
 * Age group boundaries, in months at 1 September.
 *
 * Measured, not decreed. Two independent exports agree: תינוק tops out at
 * 14.6 months and פעוט starts at 15.8; פעוט tops out at 22.3 and בוגר starts
 * at 24.0. The first boundary is therefore solid at 15 months. The second sits
 * somewhere in a gap no child in either file occupies, so 24 is the low end of
 * בוגר rather than a rule anyone has confirmed.
 *
 * This is why the computed group is shown next to ClickTac's own instead of
 * replacing it: on the boundary, a human has already decided, and that
 * decision is better evidence than this table.
 */
const AGE_GROUPS = [
  { name: 'תינוק', max_months: 15 },
  { name: 'פעוט', max_months: 24 },
  { name: 'בוגר', max_months: Infinity },
];

/**
 * Excel's day zero is 1899-12-30 — the 1900 leap-year bug, preserved forever.
 * 25569 is the number of those days before the Unix epoch.
 */
const EXCEL_EPOCH_OFFSET = 25569;

/**
 * The window a serial number has to fall in to be read as a date: roughly
 * 1954 to 2119. Narrow on purpose. Any number outside it is far likelier to be
 * an id, a tier or an amount that wandered into a date column than a date.
 */
const SERIAL_MIN = 20000;
const SERIAL_MAX = 80000;

/**
 * ClickTac writes dates as DD/MM/YYYY — except in the contracts export, where
 * several columns carry no cell format at all and come back as the bare Excel
 * serial (45657, or 46196.38 with the time of day on it). `raw: false` renders
 * a FORMATTED date cell as text and leaves an unformatted one as its number,
 * so both shapes reach this function from the same read.
 *
 * Parsed as UTC so no timezone shifts them.
 */
function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  const s = String(value).trim();
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dmy) return new Date(Date.UTC(+dmy[3], +dmy[2] - 1, +dmy[1]));
  if (/^\d{4,5}(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n >= SERIAL_MIN && n <= SERIAL_MAX) {
      return new Date(Math.round((n - EXCEL_EPOCH_OFFSET) * 86400000));
    }
    // A bare number that is not a plausible serial is not a date. Falling
    // through to `new Date(s)` would read "1234" as the year 1234.
    return null;
  }
  // ISO, the only other shape worth accepting — it is what this system's own
  // stored dates serialise to, so a re-parse of a value that has been through
  // the database has to survive.
  //
  // EVERYTHING ELSE IS REFUSED, and `new Date(s)` is deliberately gone. It
  // read "01/09/26" — a two-digit year, which ClickTac does write when the
  // cell was typed by hand — as the 9th of January in the American order, so a
  // child born in September came out born in January and nothing anywhere said
  // so. A date this function cannot read is better absent than wrong.
  if (/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(s)) {
    const d = new Date(s.length === 10 ? `${s}T00:00:00Z` : s);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

const str = (v) => (v == null ? '' : String(v).trim());
// ClickTac's "פרטי כרטיס אשראי …" cell holds the card number as typed —
// sometimes masked, sometimes not. We only ever want the last 4 digits;
// never store or forward anything longer than that.
const last4 = (v) => str(v).replace(/\D/g, '').slice(-4);
const bool = (v) => {
  const s = str(v).toUpperCase();
  if (!s) return false;
  return s === 'TRUE' || s === 'כן' || s === '1';
};

/** Whole months between two dates — 14.6 months is not 15. */
function ageInMonths(birthDate, at) {
  if (!birthDate) return null;
  const months = (at.getUTCFullYear() - birthDate.getUTCFullYear()) * 12
    + (at.getUTCMonth() - birthDate.getUTCMonth());
  const dayAdjust = at.getUTCDate() < birthDate.getUTCDate() ? -1 : 0;
  return months + dayAdjust;
}

function ageGroupFor(months) {
  if (months == null) return '';
  return (AGE_GROUPS.find(g => months < g.max_months) || AGE_GROUPS[AGE_GROUPS.length - 1]).name;
}

/**
 * The `computed` block, from a birth date and a gan year.
 *
 * Shared by both parsers so a child imported from the contracts export and the
 * same child imported from the registrations export land on the same age
 * group. Two copies of this arithmetic would eventually disagree on a
 * fourteen-and-a-half-month-old, and the disagreement would look like data.
 */
function computedFor(birth, year, sourceGroup) {
  // The gan year starts on 1 September, and that is the date every placement
  // decision is made against — not today, and not the import date.
  const yearStart = new Date(Date.UTC(Number(String(year).split('-')[0]), 8, 1));
  const months = ageInMonths(birth, yearStart);
  const computedGroup = ageGroupFor(months);
  return {
    age_months: months,
    age_group: computedGroup,
    // null, not false, when ClickTac left the layer blank — "we don't know"
    // and "they disagree" are different answers.
    agrees_with_source: sourceGroup ? computedGroup === sourceGroup : null,
  };
}

/**
 * One spreadsheet row -> one ExternalEnrollment payload.
 *
 * `academic_year` comes from the file (`שנת לימודים`, a Hebrew year) and
 * `branch_id` from the caller. Everything else is the row.
 */
function parseRow(row, { branchId, sourceFile = '' }) {
  const c = (key) => row[COLUMNS[key]];

  const year = normalizeYear(str(c('year')));
  const birth = parseDate(c('birth_date'));
  const sourceGroup = str(c('age_group'));
  const computed = computedFor(birth, year, sourceGroup);

  const firstName = str(c('child_first'));
  const lastName = str(c('child_last'));

  const enrollment = {
    status: str(c('status')),
    continuing: bool(c('continuing')),
    second_signer: str(c('second_signer')),
    registered_at: parseDate(c('registered_at')),
    portal: str(c('portal')),
    receipt_number: str(c('receipt')),
    registration_fee_method: str(c('reg_fee_method')),
    registration_fee_card_last4: last4(c('reg_fee_card')),
    tuition_method: str(c('tuition_method')),
    tuition_card_last4: last4(c('tuition_card')),
    voucher_number: str(c('voucher')),
    amount: Number(str(c('amount')).replace(/[^\d.-]/g, '')) || 0,
  };

  // Pulled out of the document literal so the payment check below can be
  // handed both halves of the answer — the method the family chose and the
  // bank details behind it — before either is written anywhere.
  const standingOrder = {
    bank: str(c('so_bank')),
    branch: str(c('so_branch')),
    account: str(c('so_account')),
    holder_name: str(c('so_holder')),
  };

  const doc = {
    source: 'clicktac',
    source_file: sourceFile,
    branch_id: branchId,
    academic_year: year,

    child: {
      first_name: firstName,
      last_name: lastName,
      full_name: `${firstName} ${lastName}`.trim(),
      id_number: str(c('child_id')),
      birth_date: birth,
      gender: str(c('gender')),
      age_group: sourceGroup,
      health_fund: str(c('health_fund')),
      has_allergy: bool(c('allergy')),
      allergy_detail: str(c('allergy_detail')),
      aide_name: str(c('aide_name')),
      aide_phone: str(c('aide_phone')),
      welfare_referred: bool(c('welfare')),
    },

    parent1: {
      first_name: str(c('p1_first')),
      last_name: str(c('p1_last')),
      id_number: str(c('p1_id')),
      relation: str(c('p1_relation')),
      marital_status: str(c('p1_marital')),
      address: str(c('p1_address')),
      phone: str(c('p1_phone')),
      email: str(c('p1_email')),
      occupation: str(c('p1_occupation')),
      is_self_employed: bool(c('p1_self_employed')),
    },
    parent2: {
      first_name: str(c('p2_first')),
      last_name: str(c('p2_last')),
      id_number: str(c('p2_id')),
      relation: str(c('p2_relation')),
      marital_status: str(c('p2_marital')),
      address: str(c('p2_address')),
      phone: str(c('p2_phone')),
      email: str(c('p2_email')),
      occupation: str(c('p2_occupation')),
      is_self_employed: bool(c('p2_self_employed')),
    },

    enrollment,
    standing_order: standingOrder,

    // Which of the two ClickTac exports this row's data came from. A row that
    // has only ever been in the contracts export has no parents in it and
    // cannot become a registration — see the promotion guard.
    sources: ['registrations'],

    computed: {
      ...computed,
      // Stored so the queue can be COUNTED and filtered without re-deriving
      // the rule over every row. It is recomputed on read as well
      // (services/paymentCheck.js), which is what gives rows imported before
      // this existed their flag without a re-import — this copy is the index,
      // not the source of truth.
      payment_alert: paymentAlert(enrollment, standingOrder),
    },

    raw: row,
  };

  doc.content_hash = hashPayload(doc);
  return doc;
}

/**
 * A hash of the meaning, not of the file.
 *
 * `raw` is excluded on purpose: a column reordered or a trailing space added
 * by the export is not a change to the enrollment, and re-importing the same
 * data should be a no-op rather than 77 modifications.
 *
 * This used to pass the sorted key list as JSON.stringify's second argument,
 * which is a recursive property ALLOWLIST rather than a sort order — it
 * emptied every nested object, so `child`, `parent1` and `enrollment` were not
 * in the hash at all and no re-import ever detected a change. See
 * utils/stable-hash.js.
 *
 * `sources` is excluded for a different reason: it is bookkeeping about WHICH
 * FILES this row has been in, not about the child. A row that gained the
 * contracts export must not read as "the registrations export changed" the
 * next time that export is uploaded.
 */
function hashPayload(doc) {
  const {
    raw, content_hash, source_file, sources, ...meaningful
  } = doc;
  return stableHash(meaningful);
}

/** Every row of the sheet, parsed. Rows with no child ת״ז are not enrollments. */
function parseSheet(rows, opts) {
  return rows
    .map(row => parseRow(row, opts))
    .filter(d => d.child.id_number || d.child.full_name);
}

/* ================================================================== *
 * The contracts export
 * ================================================================== */

/**
 * `ת.ז. או דרכון` holds one of two different things and the column next to it
 * says which.
 *
 * A ת"ז is nine digits and anything that is not a digit in it — a space, a
 * dash, a stray apostrophe — is noise; stripping it is what makes the merge
 * key comparable with the registrations export, which writes the same number
 * its own way. A passport number is NOT: it carries letters, and stripping
 * them would turn two different passports into the same digits.
 */
function parseIdNumber(value, idType) {
  const raw = str(value);
  if (!raw) return '';
  if (/דרכון/.test(str(idType))) return raw;
  return raw.replace(/\D/g, '');
}

/**
 * The value two records are the same child BY.
 *
 * Every comparison of one child against another — the merge, the match against
 * an existing registration — goes through this, and it must never be
 * `replace(/\D/g, '')`. `AB123456` and `CD123456` are two different passports
 * and two different children; stripping the letters leaves `123456` for both,
 * and the second one silently merges into the first's row, taking its class,
 * its דרגה and its contract with it.
 *
 * So: a passport keeps every character (upper-cased, because the two exports
 * do not agree on case), and only a number that is actually a number is
 * reduced to its digits — which is what makes a ת"ז written `241111117` in one
 * file and `241-111-117` in the other compare equal.
 *
 * A Latin letter anywhere in the value is enough to treat it as a passport
 * even when `id_type` is missing: the ת"ז has none, and the records this
 * system stores outside the ClickTac queue (a Registration, a Child) carry no
 * type at all.
 */
function idKey(child) {
  const raw = str(child?.id_number);
  if (!raw) return '';
  if (/דרכון/.test(str(child?.id_type)) || /[A-Za-z]/.test(raw)) return raw.toUpperCase();
  return raw.replace(/\D/g, '');
}

/**
 * One contracts row -> the two halves this system stores it as.
 *
 * `child` is the same shape the registrations parser produces, so a row
 * created from this file and a row created from that one are the same record
 * with different fields filled. `contract` is everything this export knows
 * that the other one does not.
 *
 * `שכר לימוד` stays a STRING on purpose — it is "מימון משרד הכלכלה", a funding
 * arrangement, and the actual fee is still the branch's state matrix crossed
 * with `דרגה`. `דרגה` stays a string too, because 0 is a real tier and a
 * numeric coercion of a blank cell would invent tier 0 for everyone.
 */
function parseContractsRow(row, { branchId = null, sourceFile = '' } = {}) {
  const c = (key) => row[CONTRACT_COLUMNS[key]];

  const yearLabel = str(c('year'));
  const year = normalizeYear(yearLabel);
  const birth = parseDate(c('birth_date'));
  const sourceGroup = str(c('age_group'));
  const firstName = str(c('child_first'));
  const lastName = str(c('child_last'));

  // The family half, present only in the wider export. A party is written
  // only when the file names somebody — an empty parent object would read as
  // "parents arrived, all blank" to every consumer that tests for presence.
  const address = [str(c('address')), str(c('city'))].filter(Boolean).join(', ');
  const party = (n) => {
    const first = str(c(`p${n}_first`));
    const last = str(c(`p${n}_last`));
    const phone = str(c(`p${n}_phone`));
    if (!first && !last && !phone) return null;
    return {
      first_name: first,
      last_name: last,
      id_number: str(c(`p${n}_id`)).replace(/\D/g, ''),
      phone,
      email: str(c(`p${n}_email`)),
      address,
    };
  };
  const parent1 = party(1);
  const parent2 = party(2);
  const money = (v) => {
    const s = str(v).replace(/[^\d.-]/g, '');
    if (s === '' || s === '-' || s === '.') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  // Present in the header at all? Decides whether nulls below mean "the file
  // did not say" or "the file said zero".
  const carriesFamily = CONTRACT_COLUMNS.p1_phone in row;

  return {
    branch_id: branchId,
    academic_year: year,
    source_file: sourceFile,
    // What this export carries beyond the contract — read by the importer to
    // decide whether to touch the family fields at all.
    carries_family: carriesFamily,
    ...(parent1 ? { parent1 } : {}),
    ...(parent2 ? { parent2 } : {}),

    child: {
      first_name: firstName,
      last_name: lastName,
      full_name: `${firstName} ${lastName}`.trim(),
      nickname: str(c('nickname')),
      id_number: parseIdNumber(c('id_number'), c('id_type')),
      id_type: str(c('id_type')),
      birth_date: birth,
      health_fund: str(c('health_fund')),
      medical_notes: str(c('medical_notes')),
      age_group: sourceGroup,
    },

    contract: {
      clicktac_id: str(c('contract_id')),
      status: str(c('status')),
      registered_at: parseDate(c('registered_at')),
      // The vendor's own name for the מעון. NOT the branch — see the note on
      // CONTRACT_COLUMNS and on branch_id in the model.
      institution: str(c('institution')),
      academic_year_label: yearLabel,
      class_name: str(c('class_name')),
      tuition_type: str(c('tuition_type')),
      tier: str(c('tier')),
      start_date: parseDate(c('start_date')),
      end_date: parseDate(c('end_date')),
      tags: str(c('tags')),
      admin_notes: str(c('admin_notes')),
      created_by: str(c('created_by')),
      created_at: parseDate(c('created_at')),
      updated_by: str(c('updated_by')),
      updated_at: parseDate(c('updated_at')),
      source_file: sourceFile,
      // The wider export's own facts. Null when the column is not in the
      // file — see CONTRACT_COLUMNS — and only then.
      balance: money(c('balance')),
      family_balance: money(c('family_balance')),
      deposit: money(c('deposit')),
      tuition_amount: money(c('tuition_amount')),
      continuing: carriesFamily ? bool(c('continuing')) : null,
      extended_funding: carriesFamily ? bool(c('extended_funding')) : null,
      card_last4: last4(c('card_last4')),
      terminal_type: str(c('terminal_type')),
      home_phone: str(c('home_phone')),
    },

    computed: computedFor(birth, year, sourceGroup),
  };
}

/**
 * The no-op hash for THIS export.
 *
 * Deliberately covers only what the contracts file decides. Hashing the whole
 * merged record would make every contracts re-upload look like a change the
 * moment a registrations upload touched a phone number, which is the opposite
 * of what the hash is for.
 */
function hashContract(parsed) {
  const { source_file: _f, ...contract } = parsed.contract || {};
  return stableHash({
    child: parsed.child,
    academic_year: parsed.academic_year,
    computed: parsed.computed,
    contract,
    // The family, when this export carries it: a phone corrected in ClickTac
    // has to read as a change here, or the re-upload is a no-op and the old
    // number stays.
    parent1: parsed.parent1 || null,
    parent2: parsed.parent2 || null,
  });
}

/** Every contract row, parsed. A row with neither an id nor a name is not one. */
function parseContractsSheet(rows, opts) {
  return rows
    .map(row => parseContractsRow(row, opts))
    .filter(d => d.child.id_number || d.child.full_name)
    .map(d => ({ ...d, content_hash_contracts: hashContract(d) }));
}

/** Which expected columns this file is missing — checked before anything is written. */
function missingColumns(row) {
  const required = ['child_first', 'child_last', 'child_id', 'birth_date', 'year', 'p1_phone'];
  const names = new Set(headerNames(row));
  return required.filter(k => !names.has(COLUMNS[k])).map(k => COLUMNS[k]);
}

/**
 * Which of the two exports this is — decided by the header row and nothing
 * else.
 *
 * NOT by the file name. `contracts_export_1739.xlsx` is what the portal calls
 * it on the way out, and by the time it reaches an upload box it has been
 * renamed, copied, or downloaded twice with a "(1)" on the end. The columns
 * are the only thing about the file that survives the trip.
 *
 * The registrations export is identified by a column the contracts export
 * cannot have: `שם פרטי של הנרשם` names the REGISTRANT, and the contracts
 * export has no registrant in it at all.
 *
 * The contracts export is identified by its own id column plus two of the
 * three fields only a contract carries. Both halves are required: `ת.ז. או
 * דרכון` alone is a plausible column for some future report, and two of
 * דרגה/מעון/שכר לימוד alone is what a truncated or hand-edited sheet looks
 * like. Two of three rather than three of three, because a vendor renaming one
 * label should not make a whole file unreadable.
 */
const CONTRACT_ONLY_COLUMNS = ['שכר לימוד', 'דרגה', 'מעון'];

const WRONG_EXPORT_MESSAGE = 'הקובץ אינו אחד משני הייצואים של קליקטאק. המערכת קולטת את '
  + 'ייצוא הנרשמים (Registrations Export — פרטי הילד/ה, שני ההורים ואמצעי התשלום) '
  + 'ואת ייצוא החוזים (contracts_export — כיתה, דרגה, סוג מימון ותאריכי חוזה).';

/** The header row's column names, whether it arrives as a row object or a list. */
function headerNames(headers) {
  if (Array.isArray(headers)) return headers.map(h => String(h ?? '').trim());
  return Object.keys(headers || {}).map(h => String(h ?? '').trim());
}

function looksLikeContractsExport(headers) {
  const names = new Set(headerNames(headers));
  return CONTRACT_ONLY_COLUMNS.filter(c => names.has(c)).length >= 2;
}

/** `'registrations'` | `'contracts'` | `null`. */
function detectExportType(headers) {
  const names = new Set(headerNames(headers));
  if (names.has(COLUMNS.child_first)) return 'registrations';
  if (names.has(CONTRACT_COLUMNS.id_number) && looksLikeContractsExport(headers)) {
    return 'contracts';
  }
  return null;
}

/** Which expected contract columns this file is missing. */
function missingContractColumns(row) {
  const required = ['child_first', 'child_last', 'id_number', 'year'];
  const names = new Set(headerNames(row));
  return required.filter(k => !names.has(CONTRACT_COLUMNS[k])).map(k => CONTRACT_COLUMNS[k]);
}

/**
 * Is this header row usable? `{ type }` when it is, otherwise `{ error, ... }`.
 *
 * One function so the wrong-file answer and the missing-column answer cannot
 * drift apart between the importer and its test.
 *
 * NOTE ON THE RETURN SHAPE. This used to answer `null` for "fine" and an error
 * body otherwise, and the importer branched on truthiness. It now has to say
 * WHICH file it recognised, so "fine" carries a type — and callers that only
 * ask `if (headerError)` would read every good file as broken. `validateHeader`
 * therefore returns the error or null exactly as before, and `identifyHeader`
 * is the one that answers the fuller question.
 */
function identifyHeader(row) {
  const type = detectExportType(row);

  if (type === 'registrations') {
    const missing = missingColumns(row);
    if (!missing.length) return { type: 'registrations' };
    return {
      error: `חסרות עמודות בקובץ: ${missing.join(', ')}`,
      code: 'MISSING_COLUMNS',
      expected: Object.values(COLUMNS),
    };
  }

  if (type === 'contracts') {
    const missing = missingContractColumns(row);
    if (!missing.length) return { type: 'contracts' };
    return {
      error: `חסרות עמודות בקובץ החוזים: ${missing.join(', ')}`,
      code: 'MISSING_COLUMNS',
      expected: Object.values(CONTRACT_COLUMNS),
    };
  }

  // Neither file. Named as such rather than by listing the registrations
  // columns it happens to be missing — a reader sent hunting for
  // "שם פרטי של הנרשם" in a file that was never going to have it is a reader
  // who will not go back to the portal.
  if (looksLikeContractsExport(row)) {
    return { error: WRONG_EXPORT_MESSAGE, code: 'WRONG_EXPORT_TYPE' };
  }
  const missing = missingColumns(row);
  return {
    error: `חסרות עמודות בקובץ: ${missing.join(', ')}`,
    code: 'MISSING_COLUMNS',
    expected: Object.values(COLUMNS),
  };
}

/** The refusal, or null when the header is one of the two exports. */
function validateHeader(row) {
  const verdict = identifyHeader(row);
  return verdict.type ? null : verdict;
}

module.exports = {
  COLUMNS, CONTRACT_COLUMNS, AGE_GROUPS, CONTRACT_ONLY_COLUMNS, WRONG_EXPORT_MESSAGE,
  parseRow, parseSheet, missingColumns, missingContractColumns,
  looksLikeContractsExport, detectExportType, identifyHeader, validateHeader,
  parseContractsRow, parseContractsSheet, hashContract, parseIdNumber, idKey,
  ageInMonths, ageGroupFor, computedFor, parseDate, hashPayload,
  institutionMatchesBranch,
};
