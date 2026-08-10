/**
 * Reading a קליקטאק registrations export.
 *
 * The column names are Hebrew and they are the vendor's, not ours — they will
 * change when ClickTac changes a label, and when they do the fix has to be one
 * line in a map rather than a hunt through parsing code. Everything this file
 * knows about the file's shape is in COLUMNS.
 *
 * Two things are deliberately NOT read from the file:
 *
 *   the branch  — `מוסד` says "כפר סבא" on every row and there are two
 *                 branches in Kfar Saba. It is passed in at import.
 *   the class   — the age group is computed here and compared with ClickTac's,
 *                 never silently overwritten.
 */

const crypto = require('crypto');
const { normalizeYear } = require('./academic-year.service');

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

/** ClickTac writes dates as DD/MM/YYYY. Parsed as UTC so no timezone shifts them. */
function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  const s = String(value).trim();
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dmy) return new Date(Date.UTC(+dmy[3], +dmy[2] - 1, +dmy[1]));
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

const str = (v) => (v == null ? '' : String(v).trim());
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
 * One spreadsheet row -> one ExternalEnrollment payload.
 *
 * `academic_year` comes from the file (`שנת לימודים`, a Hebrew year) and
 * `branch_id` from the caller. Everything else is the row.
 */
function parseRow(row, { branchId, sourceFile = '' }) {
  const c = (key) => row[COLUMNS[key]];

  const year = normalizeYear(str(c('year')));
  const birth = parseDate(c('birth_date'));

  // The gan year starts on 1 September, and that is the date every placement
  // decision is made against — not today, and not the import date.
  const yearStart = new Date(Date.UTC(Number(year.split('-')[0]), 8, 1));
  const months = ageInMonths(birth, yearStart);
  const computedGroup = ageGroupFor(months);
  const sourceGroup = str(c('age_group'));

  const firstName = str(c('child_first'));
  const lastName = str(c('child_last'));

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

    enrollment: {
      status: str(c('status')),
      continuing: bool(c('continuing')),
      second_signer: str(c('second_signer')),
      registered_at: parseDate(c('registered_at')),
      portal: str(c('portal')),
      receipt_number: str(c('receipt')),
      registration_fee_method: str(c('reg_fee_method')),
      registration_fee_card_last4: str(c('reg_fee_card')),
      tuition_method: str(c('tuition_method')),
      tuition_card_last4: str(c('tuition_card')),
      voucher_number: str(c('voucher')),
      amount: Number(str(c('amount')).replace(/[^\d.-]/g, '')) || 0,
    },

    standing_order: {
      bank: str(c('so_bank')),
      branch: str(c('so_branch')),
      account: str(c('so_account')),
      holder_name: str(c('so_holder')),
    },

    computed: {
      age_months: months,
      age_group: computedGroup,
      // null, not false, when ClickTac left the layer blank — "we don't know"
      // and "they disagree" are different answers.
      agrees_with_source: sourceGroup ? computedGroup === sourceGroup : null,
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
 */
function hashPayload(doc) {
  const { raw, content_hash, source_file, ...meaningful } = doc;
  return crypto.createHash('sha256')
    .update(JSON.stringify(meaningful, Object.keys(meaningful).sort()))
    .digest('hex');
}

/** Every row of the sheet, parsed. Rows with no child ת״ז are not enrollments. */
function parseSheet(rows, opts) {
  return rows
    .map(row => parseRow(row, opts))
    .filter(d => d.child.id_number || d.child.full_name);
}

/** Which expected columns this file is missing — checked before anything is written. */
function missingColumns(row) {
  const required = ['child_first', 'child_last', 'child_id', 'birth_date', 'year', 'p1_phone'];
  return required.filter(k => !(COLUMNS[k] in row)).map(k => COLUMNS[k]);
}

module.exports = {
  COLUMNS, AGE_GROUPS,
  parseRow, parseSheet, missingColumns,
  ageInMonths, ageGroupFor, parseDate, hashPayload,
};
