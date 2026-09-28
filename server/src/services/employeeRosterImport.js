'use strict';

/**
 * The accountant's roster, compared against ours — WITHOUT writing anything.
 *
 * שקלולית issues two yearly reports the gan has never been able to use:
 * `אלפון עובדים` (identity and contact details) and `דוח העדרויות` (the closing
 * חופשה / מחלה / הבראה balance per employee). Both have been retyped by hand or
 * not entered at all, which is how an employee ends up owed leave nobody can
 * account for.
 *
 * This module turns a parsed roster into a PLAN: for every employee, the fields
 * that would change and what they would change from. Nothing here touches the
 * database. Applying the plan is a separate, explicit call — because these are
 * ninety-five real people's telephone numbers, birth dates and leave balances,
 * and a silent bulk overwrite is not reviewable after the fact.
 *
 * ── The three rules that make this safe ──
 *
 * MATCH ON ת"ז, NEVER ON NAME. The Israeli ID is the only key both systems
 * agree on; it is also what the TIMEDOX clock stores. Names differ by spelling,
 * marriage and transliteration, and the roster's own Hebrew arrives with
 * letters dropped by the PDF font. An ID that is not ours is REPORTED, never
 * inserted — creating an employee from a payroll roster would manufacture staff
 * nobody hired.
 *
 * EMPTY NEVER OVERWRITES. Twenty-six of the ninety-five rows carry no email at
 * all. "Not in this report" is not "cleared": treating it as a value would
 * delete addresses the office collected itself.
 *
 * A BALANCE WITHOUT ITS MONTH IS NOT A BALANCE. Leave accrues forward from the
 * month it was measured, so a figure with no as_of_month cannot be used at all,
 * and one measured BEFORE what we already hold would walk the balance backwards.
 * Both are refused rather than guessed.
 */

const { Employee } = require('../models');

/** Fields copied straight across when the roster has a value and it differs. */
const PLAIN_FIELDS = [
  { key: 'employee_number', label: 'מספר עובד' },
  { key: 'email', label: 'מייל' },
  { key: 'phone', label: 'טלפון' },
  { key: 'postal_code', label: 'מיקוד' },
  { key: 'marital_status', label: 'מצב משפחתי' },
  { key: 'gender', label: 'מין' },
];

const MARITAL = ['רווק/ה', 'נשוי/אה', 'גרוש/ה', 'אלמן/ה', 'פרוד/ה'];

/**
 * Plain numbers copied across. Kept apart from PLAIN_FIELDS because '0' is a
 * real value here and must not be mistaken for the empty string that means
 * "this report says nothing" — 0.000 in the accountant's accrual column is a
 * statement that the employee accrues nothing, and it has to be able to
 * overwrite a stale rate.
 */
const NUMERIC_FIELDS = [
  { key: 'vacation_monthly_accrual', label: 'צבירת חופשה לחודש', from: 'vacation_accrual' },
];

const BALANCES = [
  { key: 'vacation_balance_opening', label: 'יתרת חופשה', from: 'vacation_balance' },
  { key: 'sick_balance_opening', label: 'יתרת מחלה', from: 'sick_balance' },
  { key: 'recreation_balance_opening', label: 'יתרת הבראה', from: 'recreation_balance' },
];

const str = (v) => (v == null ? '' : String(v).trim());

/** ת"ז as both systems store it: nine digits, leading zeros kept. */
function normalizeId(v) {
  const digits = str(v).replace(/\D/g, '');
  return digits ? digits.padStart(9, '0') : '';
}

/**
 * The check digit, so a mistyped ID is caught here rather than after it has
 * been written onto somebody's record.
 */
function isValidIsraeliId(v) {
  const s = normalizeId(v);
  if (s.length !== 9) return false;
  let total = 0;
  for (let i = 0; i < 9; i += 1) {
    const d = Number(s[i]) * (i % 2 === 0 ? 1 : 2);
    total += d > 9 ? d - 9 : d;
  }
  return total % 10 === 0;
}

/** Phones are compared by digits alone — 054-123 and 054123 are one number. */
const phoneDigits = (v) => str(v).replace(/\D/g, '');

/** 'DD/MM/YYYY' (what שקלולית prints) → Date, or null. */
function parseBirthDate(v) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(str(v));
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const d = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
  if (Number.isNaN(d.getTime())) return null;
  if (d.getUTCDate() !== Number(dd) || d.getUTCMonth() !== Number(mm) - 1) return null;
  return d;
}

const ymd = (d) => (d instanceof Date && !Number.isNaN(d.getTime())
  ? d.toISOString().slice(0, 10) : '');

/** 'YYYY-MM' ordering, used to refuse a balance older than the one on file. */
const monthIsBefore = (a, b) => String(a) < String(b);

/**
 * Normalise one incoming row. Anything unrecognised becomes '' rather than a
 * guess — a marital status outside the closed set is a typo, and writing it
 * would put a value into the record that no screen can display.
 */
function normalizeRow(raw) {
  const gender = str(raw.gender);
  const marital = str(raw.marital_status || raw.marital);
  return {
    israeli_id: normalizeId(raw.israeli_id),
    employee_number: str(raw.employee_number),
    email: str(raw.email).toLowerCase(),
    phone: phoneDigits(raw.phone),
    postal_code: str(raw.postal_code || raw.postal),
    marital_status: MARITAL.includes(marital) ? marital : '',
    gender: gender === 'נקבה' || gender === 'female' ? 'female'
      : (gender === 'זכר' || gender === 'male' ? 'male' : ''),
    birth_date: parseBirthDate(raw.birth_date),
    vacation_monthly_accrual: str(raw.vacation_accrual ?? raw.vacation_monthly_accrual),
    vacation_balance: raw.vacation_balance,
    sick_balance: raw.sick_balance,
    recreation_balance: raw.recreation_balance,
  };
}

function balanceChange(emp, row, spec, asOfMonth) {
  const incoming = str(row[spec.from]);
  if (incoming === '') return null;
  const days = Number(incoming);
  if (!Number.isFinite(days)) return null;
  if (!asOfMonth) {
    return { field: spec.key, label: spec.label, blocked: true,
      reason: 'היתרה הגיעה בלי חודש — בלי חודש אי אפשר לצבור קדימה.' };
  }
  const current = emp[spec.key] || {};
  const curDays = Number(current.days || 0);
  const curMonth = current.as_of_month || null;

  // A balance measured before the one on file would walk it backwards, undoing
  // months of accrual that already happened.
  if (curMonth && monthIsBefore(asOfMonth, curMonth)) {
    return { field: spec.key, label: spec.label, blocked: true,
      reason: `הקובץ נכון ל-${asOfMonth} והמערכת כבר מחזיקה יתרה נכון ל-${curMonth} — קליטה תחזיר את היתרה אחורה.` };
  }
  if (curMonth === asOfMonth && Math.abs(curDays - days) < 0.0005) return null;
  return {
    field: spec.key, label: spec.label,
    before: curMonth ? `${curDays} (${curMonth})` : '—',
    after: `${days} (${asOfMonth})`,
    value: { days, as_of_month: asOfMonth },
  };
}

/**
 * Build the plan.
 *
 * @param {object[]} rows      parsed roster rows
 * @param {string?}  asOfMonth 'YYYY-MM' the balances closed on
 * @returns {Promise<{matched: object[], unknown: object[], invalid: object[], summary: object}>}
 */
async function buildImportPlan(rows, asOfMonth = null) {
  const normalized = [];
  const invalid = [];
  const seen = new Map();

  for (const raw of Array.isArray(rows) ? rows : []) {
    const row = normalizeRow(raw);
    if (!row.israeli_id) {
      invalid.push({ row: raw, reason: 'אין תעודת זהות בשורה.' });
      continue;
    }
    if (!isValidIsraeliId(row.israeli_id)) {
      invalid.push({ israeli_id: row.israeli_id, employee_number: row.employee_number,
        reason: 'תעודת זהות לא עוברת ספרת ביקורת — כנראה שגיאת הקלדה.' });
      continue;
    }
    seen.set(row.israeli_id, (seen.get(row.israeli_id) || 0) + 1);
    normalized.push(row);
  }

  // The same ת"ז twice is two different answers about one person and no way to
  // know which is current. BOTH copies are dropped — keeping the first would
  // make the outcome depend on row order, which is not a decision anybody made.
  const duplicated = new Set([...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id));
  if (duplicated.size > 0) {
    for (const id of duplicated) {
      const copies = normalized.filter((r) => r.israeli_id === id);
      invalid.push({ israeli_id: id, employee_number: copies[0]?.employee_number || '',
        reason: `התעודה מופיעה ${copies.length} פעמים בקובץ — אף אחת מהשורות לא נקלטה.` });
    }
    for (let i = normalized.length - 1; i >= 0; i -= 1) {
      if (duplicated.has(normalized[i].israeli_id)) normalized.splice(i, 1);
    }
  }

  const ids = normalized.map((r) => r.israeli_id);
  const employees = await Employee.find({ israeli_id: { $in: ids } })
    .select([
      '_id full_name israeli_id employee_number email phone postal_code',
      'marital_status gender birth_date is_active branch_id vacation_monthly_accrual',
      'vacation_balance_opening sick_balance_opening recreation_balance_opening',
    ].join(' '))
    .lean();
  const byId = new Map(employees.map((e) => [normalizeId(e.israeli_id), e]));

  const matched = [];
  const unknown = [];

  for (const row of normalized) {
    const emp = byId.get(row.israeli_id);
    if (!emp) {
      // Reported, never created: a roster is not a hiring decision.
      unknown.push({ israeli_id: row.israeli_id, employee_number: row.employee_number,
        email: row.email, phone: row.phone });
      continue;
    }

    const changes = [];
    for (const f of PLAIN_FIELDS) {
      const incoming = row[f.key];
      if (incoming === '' || incoming == null) continue; // empty never overwrites
      // Compared the way each field is stored: a phone by its digits alone, an
      // address case-insensitively. Shown, though, exactly as it sits on the
      // record — the reviewer has to recognise what is there today.
      const cur = f.key === 'phone' ? phoneDigits(emp[f.key])
        : (f.key === 'email' ? str(emp[f.key]).toLowerCase() : str(emp[f.key]));
      if (cur === incoming) continue;
      changes.push({ field: f.key, label: f.label,
        before: str(emp[f.key]) || '—', after: incoming, value: incoming });
    }

    for (const f of NUMERIC_FIELDS) {
      const incoming = str(row[f.key]);
      if (incoming === '') continue;          // absent, not zero
      const next = Number(incoming);
      if (!Number.isFinite(next) || next < 0) continue;
      const cur = Number(emp[f.key]) || 0;
      if (Math.abs(cur - next) < 0.0005) continue;
      changes.push({ field: f.key, label: f.label, before: String(cur), after: String(next), value: next });
    }

    if (row.birth_date) {
      const cur = ymd(emp.birth_date);
      const next = ymd(row.birth_date);
      if (cur !== next) {
        changes.push({ field: 'birth_date', label: 'תאריך לידה',
          before: cur || '—', after: next, value: row.birth_date });
      }
    }

    for (const spec of BALANCES) {
      const ch = balanceChange(emp, row, spec, asOfMonth);
      if (ch) changes.push(ch);
    }

    matched.push({
      employee_id: String(emp._id),
      full_name: emp.full_name,
      israeli_id: row.israeli_id,
      is_active: emp.is_active !== false,
      changes: changes.filter((c) => !c.blocked),
      blocked: changes.filter((c) => c.blocked),
    });
  }

  const withChanges = matched.filter((m) => m.changes.length > 0);
  return {
    matched,
    unknown,
    invalid,
    summary: {
      rows: Array.isArray(rows) ? rows.length : 0,
      matched: matched.length,
      with_changes: withChanges.length,
      unchanged: matched.length - withChanges.length,
      unknown: unknown.length,
      invalid: invalid.length,
      blocked: matched.reduce((n, m) => n + m.blocked.length, 0),
      as_of_month: asOfMonth,
    },
  };
}

/** Only these may ever be written from a roster. */
const WRITABLE = new Set([
  ...PLAIN_FIELDS.map((f) => f.key),
  ...NUMERIC_FIELDS.map((f) => f.key),
  'birth_date',
  ...BALANCES.map((b) => b.key),
]);

/**
 * Apply a plan — the ONLY function here that writes.
 *
 * It re-derives the plan from the same rows rather than trusting values posted
 * back from the browser. A reviewer approves employees, not field values: if
 * the page could name both the field and what to put in it, whoever held that
 * page could write anything onto anyone.
 *
 * `approvedIds` is the ת"ז of every employee the reviewer ticked. An employee
 * not in that list is left exactly as she was, and a blocked change stays
 * blocked no matter who ticked what.
 *
 * @returns {Promise<{updated: object[], skipped: object[], failed: object[]}>}
 */
async function applyImportPlan(rows, asOfMonth, approvedIds) {
  const approved = new Set((approvedIds || []).map(normalizeId).filter(Boolean));
  const plan = await buildImportPlan(rows, asOfMonth);

  const updated = [];
  const skipped = [];
  const failed = [];

  for (const m of plan.matched) {
    if (!approved.has(m.israeli_id)) { skipped.push({ israeli_id: m.israeli_id, reason: 'לא אושר' }); continue; }
    if (m.changes.length === 0) { skipped.push({ israeli_id: m.israeli_id, reason: 'אין מה לשנות' }); continue; }

    const $set = {};
    for (const c of m.changes) {
      if (!WRITABLE.has(c.field)) continue; // belt and braces; the plan never emits others
      $set[c.field] = c.value;
    }
    if (Object.keys($set).length === 0) { skipped.push({ israeli_id: m.israeli_id, reason: 'אין שדה שניתן לכתיבה' }); continue; }

    try {
      // runValidators so the marital-status set and the gender enum are enforced
      // by the schema and not only by this file.
      await Employee.updateOne({ _id: m.employee_id }, { $set }, { runValidators: true });
      updated.push({ israeli_id: m.israeli_id, full_name: m.full_name,
        fields: m.changes.map((c) => c.label) });
    } catch (e) {
      failed.push({ israeli_id: m.israeli_id, full_name: m.full_name, error: e.message });
    }
  }

  return { updated, skipped, failed, summary: {
    updated: updated.length, skipped: skipped.length, failed: failed.length,
  } };
}

module.exports = {
  buildImportPlan,
  applyImportPlan,
  normalizeRow,
  normalizeId,
  isValidIsraeliId,
  parseBirthDate,
  PLAIN_FIELDS,
  NUMERIC_FIELDS,
  BALANCES,
  MARITAL,
};
