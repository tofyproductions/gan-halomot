/**
 * Reading a משרד התמ"ת approvals export (`child-list_export`).
 *
 * Every February the ministry runs the national registration, and in July it
 * publishes, per מעון, the children it has approved. That list is one half of
 * the answer to "who is enrolled next year"; the ClickTac export is the other.
 * A child needs BOTH — approved by the ministry and registered with us — and
 * the whole point of parsing this file is to find the ones who only have one.
 *
 * Two things are deliberately NOT read from the file:
 *
 *   the branch  — the file has no branch column at all. The ministry's portal
 *                 is per-מעון, so the operator downloads one file inside each
 *                 gan's own account; which gan it was is known at upload and
 *                 nowhere in the bytes.
 *   the year    — same reason. The export carries decisions, not a year.
 *
 * קפלן never appears here. It is not under the ministry and its families
 * register directly with us, so it has no ministry list to be compared with.
 */

const { stableHash } = require('../utils/stable-hash');

/** Ministry column -> what it means. The whole file-format contract. */
const COLUMNS = {
  first_name: 'שם פרטי',
  last_name: 'שם משפחה',
  id_number: 'תעודת זהות',
  birth_date: 'תאריך לידה',
  priority: 'עדיפות',
  committee_place: 'מקום בוועדה',
  decision: 'החלטה',
  contact_name: 'שם המלא להתקשרות',
  contact_phone: 'טלפון',
  contact_email: 'מייל',
  age_group: 'קבוצת גיל',
  continuing: 'ילד ממשיך',
  welfare: 'ילד רווחה',
  absorbed_at: 'תאריך הקליטה',
};

/**
 * Decisions that mean "this child may enroll with us".
 *
 * Both are approvals, and the difference between them is a task of OURS rather
 * than a decision of theirs:
 *
 *   התקבל       — approved, and nobody has entered a תאריך כניסה לגן for them
 *                 in the ministry's portal yet. That entry is our job.
 *   נקלט במעון  — approved, and the entry date has been filled in.
 *
 * The file itself proves it: in the July export every one of the 14 נקלט rows
 * carries תאריך הקליטה 01/09/2026 and all 60 התקבל rows have it blank. So the
 * missing date is reported as a finding (see enrollment-reconcile.service.js)
 * and the two wordings are one answer here.
 *
 * Anything else is not an approval and is reported by name rather than
 * silently bucketed, so the day the ministry adds a third wording it shows up
 * as a finding instead of quietly dropping a child.
 */
const APPROVED_DECISIONS = ['התקבל', 'נקלט במעון'];

/** The wording the ministry uses once an entry date has been filled in. */
const ABSORBED_DECISION = 'נקלט במעון';

/**
 * The ministry writes age groups in the plural, ClickTac in the singular.
 * Same three layers, two vocabularies; every comparison goes through here.
 */
const AGE_GROUP_ALIASES = {
  'תינוקות': 'תינוק',
  'תינוק': 'תינוק',
  'פעוטות': 'פעוט',
  'פעוט': 'פעוט',
  'בוגרים': 'בוגר',
  'בוגר': 'בוגר',
};

const str = (v) => (v == null ? '' : String(v).trim());

/**
 * A ת"ז reduced to what two systems can agree on.
 *
 * The ministry pads with a leading space, ClickTac keeps leading zeros
 * (043116995 is a real row). Stripping zeros would make 043116995 and
 * 43116995 different children; padding to nine makes them the same one.
 */
function normalizeId(value) {
  const digits = str(value).replace(/\D/g, '');
  return digits ? digits.padStart(9, '0') : '';
}

/** Israeli mobile numbers, comparable across two systems' formatting. */
function normalizePhone(value) {
  const digits = str(value).replace(/\D/g, '');
  if (!digits) return '';
  return digits.replace(/^972/, '0').replace(/^(?!0)/, '0').slice(-10);
}

/** The ministry writes dates as DD/MM/YYYY. Parsed as UTC so no timezone shifts them. */
function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  const s = str(value);
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dmy) return new Date(Date.UTC(+dmy[3], +dmy[2] - 1, +dmy[1]));
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

const yesNo = (v) => {
  const s = str(v);
  if (!s) return null;               // blank is "not stated", not "no"
  return s === 'כן' || s === 'TRUE' || s === '1';
};

/** תינוקות -> תינוק. Unknown wordings pass through untranslated, on purpose. */
function canonicalAgeGroup(value) {
  const s = str(value);
  return AGE_GROUP_ALIASES[s] || s;
}

/**
 * Find the header row and read the sheet as objects.
 *
 * The ministry's first row is "הערה: המידע חסוי ולא ניתן להעברה" — a warning,
 * not a header — so the usual sheet_to_json would take the warning as the
 * column names and every row would come back empty. The header is located by
 * the one column that must be there rather than by a row number, because a
 * second banner line added next year would move it.
 */
function readSheet(rows) {
  const headerIndex = rows.findIndex(r => Array.isArray(r)
    && r.some(cell => str(cell) === COLUMNS.id_number));
  if (headerIndex === -1) return { header: [], records: [] };

  const header = rows[headerIndex].map(h => str(h));
  const records = rows.slice(headerIndex + 1)
    .filter(r => Array.isArray(r) && r.some(cell => str(cell)))
    .map(r => Object.fromEntries(header.map((h, i) => [h, r[i]])));
  return { header, records };
}

/** One spreadsheet row -> one TmtApproval payload. */
function parseRow(row, { branchId, academicYear, sourceFile = '' }) {
  const c = (key) => row[COLUMNS[key]];

  const firstName = str(c('first_name'));
  const lastName = str(c('last_name'));
  const decision = str(c('decision'));

  const doc = {
    source_file: sourceFile,
    branch_id: branchId,
    academic_year: academicYear,

    child: {
      first_name: firstName,
      last_name: lastName,
      full_name: `${firstName} ${lastName}`.trim(),
      id_number: normalizeId(c('id_number')),
      birth_date: parseDate(c('birth_date')),
      age_group: canonicalAgeGroup(c('age_group')),
      source_age_group: str(c('age_group')),
    },

    contact: {
      name: str(c('contact_name')),
      phone: normalizePhone(c('contact_phone')),
      email: str(c('contact_email')).toLowerCase(),
    },

    ministry: {
      decision,
      is_approved: APPROVED_DECISIONS.includes(decision),
      absorbed_at: parseDate(c('absorbed_at')),
      continuing: yesNo(c('continuing')),
      welfare: yesNo(c('welfare')),
      // עדיפות and מקום בוועדה are the state's own committee bookkeeping. They
      // are stored because they are in the file, and used for nothing: the
      // user has confirmed nobody here knows how they are decided, and a rank
      // whose rule is unknown is not something to act on.
      priority: str(c('priority')),
      committee_place: str(c('committee_place')),
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
 * by the export is not a change to the approval, and re-uploading the same
 * list in August should be a no-op rather than 74 modifications.
 */
function hashPayload(doc) {
  const { raw, content_hash, source_file, ...meaningful } = doc;
  return stableHash(meaningful);
}

/** Every row of the sheet, parsed. A row with no ת"ז is not an approval. */
function parseSheet(rows, opts) {
  const { records } = readSheet(rows);
  return records
    .map(row => parseRow(row, opts))
    .filter(d => d.child.id_number);
}

/** Which expected columns this file is missing — checked before anything is written. */
function missingColumns(rows) {
  const { header } = readSheet(rows);
  if (!header.length) return [COLUMNS.id_number];
  const required = ['first_name', 'last_name', 'id_number', 'birth_date', 'decision', 'age_group'];
  return required.filter(k => !header.includes(COLUMNS[k])).map(k => COLUMNS[k]);
}

module.exports = {
  COLUMNS, APPROVED_DECISIONS, ABSORBED_DECISION, AGE_GROUP_ALIASES,
  readSheet, parseSheet, parseRow, missingColumns,
  normalizeId, normalizePhone, canonicalAgeGroup, parseDate, hashPayload,
};
