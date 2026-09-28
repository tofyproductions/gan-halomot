'use strict';

/**
 * Payroll export — שקלולית ADAPTER.
 *
 * Turns the canonical export source (sourceLayer.js) into the two Excel files
 * שקלולית actually ingests, per the templates the accountant handed over on
 * 27.09.2026 (docs/payroll-export/):
 *
 *   1. נתוני שכר לחודש — one row per pay component per employee:
 *      חודש עבודה | מספר עובד | סוג רשומה | קוד רכיב | תעריף | כמות
 *   2. נתוני עובד — the employee master (identity + bank), used by the
 *      accountant to open new employees in שקלולית.
 *
 * MODES, PER THE ACCOUNTANT'S ANSWERS (אפרים, 27.09.2026):
 *   - HOURLY employees: שקלולית prices the hours itself — we send code 1 as
 *     rate × regular hours, and codes 32/33 as the 125%/150% rate × OT hours.
 *     The rate is COPIED from the engine's own snapshot (breakdown.rates);
 *     the 125/150 rates are that same rate × the statutory factor, which is
 *     the definition of those components, not a re-computation of pay.
 *   - GLOBAL employees: שקלולית computes brutto × (actual/standard hours) —
 *     exactly the proration our engine already resolved into base_salary, so
 *     we send the resolved amount (תעריף=סכום, כמות=1).
 *   - Everything else stays a resolved amount (bonus explicitly "בסכום").
 *   - הבראה is NOT sent — the accountant computes it by job scope.
 *   - Deductions (36 ימים חסרים, 41 שעות חסרות) go out NEGATIVE — confirmed.
 *   - Net employees: amounts are sent as-is (they are net) and the employee
 *     is flagged in the notes; the gross-up happens on the accountant's side.
 *
 *   - "סוג רשומה" says WHICH code table the row's קוד רכיב comes from:
 *     1 שכר, 2 זקופות, 3 ניכויי רשות (answered 28.09.2026). Every row this
 *     file emits today is a שכר row.
 *
 * WHAT DOES NOT GO IN THE FILE. Components whose CODES we still don't have
 * (cibus/meal value, gift card, loan/advance) and every free-text directive are
 * NOT guessed into numeric rows — knowing their table is not knowing their
 * code. They come back from buildMovements() as `notes` and land on a dedicated
 * sheet the accountant reads.
 */

const OPEN_QUESTIONS = [
  'סיבוס: שווי ארוחות מופיע פעמיים באקסולוגיית הזקופות (קוד 2 וקוד 21) — לוודא איזה מהם בשימוש. כל עוד הקוד לא ודאי, הרכיב נשאר בגיליון ההערות למרות שסוג הרשומה כבר ידוע (2).',
  'החזר הלוואה: אין קוד ייעודי בניכויי הרשות — לוודא אם נקלט כמקדמה (קוד 1).',
  'חודש ניסיון: ספטמבר 2026 — הקבצים נשלחים לרו"ח במייל.',
];

/**
 * "סוג רשומה" — which of the three code tables the row's קוד רכיב belongs to.
 * Answered 28.09.2026; the hypothesis in the original spec was right.
 *
 *   1  שכר          רכיבי שכר        (יסוד, ש"נ, נסיעות, מחלה, חג, בונוס, חסרים…)
 *   2  זקופות       הכנסות זקופות    (שווי ארוחות, שווי רכב…)
 *   3  ניכויי רשות  ניכויי רשות      (מקדמה, מפרעה…)
 *
 * It was sent EMPTY until now, on the accountant's word that the column was
 * not in use. Every row this file emits today is a רכיבי שכר row, so they all
 * carry SALARY; the table lives on the component so a row from another table
 * cannot silently inherit the wrong one.
 *
 * Knowing the table is NOT enough to move the notes-sheet components into real
 * rows — their קוד רכיב is still unconfirmed (שווי ארוחות 2 or 21, תו קנייה
 * unknown, הלוואה probably מקדמה=1). Guessing a code is exactly what cost the
 * 28.09 import; they stay on the notes sheet until the codes are confirmed.
 */
const RECORD_TYPE = Object.freeze({
  SALARY: 1,             // רכיבי שכר
  IMPUTED: 2,            // הכנסות זקופות
  VOLUNTARY_DEDUCTION: 3, // ניכויי רשות
});

/**
 * The component map: canonical field → שקלולית code (אקסולוגיה, חברה 600).
 * `sign` -1 marks a deduction, emitted as a negative amount so it cannot be
 * misread as pay — flip to +1 if the trial import shows שקלולית expects
 * positives on deduction codes.
 */
/** Amount components (תעריף=סכום, כמות=1). Base salary is handled apart. */
const COMPONENTS = [
  { key: 'salary_completion', code: 38, label: 'השלמת שכר', get: (ce) => ce.earnings.salary_completion },
  { key: 'travel', code: 3, label: 'נסיעות', get: (ce) => ce.earnings.travel },
  { key: 'holiday_pay', code: 44, label: 'ימי חג', get: (ce) => ce.earnings.holiday_pay },
  { key: 'sick_pay', code: 34, label: 'ימי מחלה', get: (ce) => ce.earnings.sick_pay },
  { key: 'bonus', code: 35, label: 'בונוס', get: (ce) => ce.earnings.bonus },
  { key: 'august_bonus', code: 39, label: 'בונוס מיוחד (מענק אוגוסט)', get: (ce) => ce.earnings.august_bonus },
  { key: 'miluim', code: 42, label: 'ימי מילואים', get: (ce) => ce.earnings.miluim },
  { key: 'absence', code: 36, label: 'ימים חסרים', sign: -1, get: (ce) => ce.deductions.absence },
  { key: 'partial_absence', code: 41, label: 'שעות חסרות', sign: -1, get: (ce) => ce.deductions.partial_absence },
];

/** Hours codes for hourly employees — שקלולית prices rate × quantity. */
const HOURS = {
  regular: { code: 1, factor: 1 },
  ot125: { code: 32, factor: 1.25 },
  ot150: { code: 33, factor: 1.5 },
};

/**
 * Components that belong to the OTHER two code tables and still ride the notes
 * sheet rather than becoming rows.
 *
 * "סוג רשומה" was the blocker and is now answered (2 זקופות, 3 ניכויי רשות),
 * but that alone does not let these out: their קוד רכיב is still unconfirmed —
 * שווי ארוחות appears TWICE in the imputed table (2 and 21), תו קנייה is not
 * in any list we hold, and loan repayment has no code of its own. Guessing a
 * code is what cost the 28.09 import, so each still travels as a note WITH its
 * candidate code, and the accountant keys it in seconds. Confirm the codes and
 * they become rows with `table` set.
 */
const UNMAPPED = [
  { key: 'meal_vouchers', label: 'תווי מזון / כלכלה', hint: 'זקופות — שווי ארוחות (קוד 2 או 21)', get: (ce) => ce.earnings.meal_vouchers },
  { key: 'cibus', label: 'סיבוס', hint: 'זקופות — שווי ארוחות (קוד 2 או 21)', get: (ce) => ce.earnings.cibus },
  { key: 'gift_card', label: 'תו קנייה (גיפט קארד)', hint: 'זקופה — לוודא קוד', get: (ce) => ce.earnings.gift_card },
  { key: 'loans', label: 'ניכוי הלוואה', hint: 'ניכוי רשות — כנראה כמקדמה (קוד 1), לוודא', get: (ce) => ce.deductions.loans },
  // הבראה — the accountant computes it by job scope; when our table carries
  // an amount anyway, it is surfaced so nobody pays it twice.
  { key: 'recreation', label: 'הבראה', hint: 'מחושבת אצל הרו"ח לפי היקף משרה — לידיעה בלבד', get: (ce) => ce.earnings.recreation },
];

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * 'חודש עבודה' — the month number, 1–12. A NUMBER, not a date string.
 *
 * We shipped `MM/YYYY` because that is what a Hebrew payroll clerk reads and
 * the accountant confirmed the shape — he was answering about what a person
 * reads. The September trial import on 28.09.2026 rejected all 203 rows, one
 * error each: "צריך להיות מספר חיובי שלם או אפס" against `09/2026`. Nothing
 * else in the file was refused.
 *
 * A three-row probe the same morning settled which number, because it is
 * documented nowhere — both templates are header-only and the two אקסולוגיה
 * tables describe component codes, not the file layout. שקלולית's answer:
 *
 *     9        accepted (absent from the error report)
 *     202609   "שדה חודש עבודה יכול להיות מספר מ 1 עד 12"
 *     0        "חודש עבודה לא מתאים"
 *
 * So the range really is 1–12 and the first message was a generic type check —
 * zero is NOT accepted despite what it said. The importer already knows the
 * year: the operator picks the period when starting the import, and its own
 * error report is headed "לחודש 9/2026".
 *
 * An unparseable month returns 0 ON PURPOSE. 0 is the one value שקלולית names
 * out loud ("חודש עבודה לא מתאים"), so a broken month fails the row with a
 * message a human can read, instead of quietly booking pay into the wrong
 * month. Never return a string here — that is the bug this replaced.
 */
function monthValue(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  if (!m) return 0;
  const mon = Number(m[2]);
  return mon >= 1 && mon <= 12 ? mon : 0;
}

/**
 * The monthly movements: rows for the נתוני שכר לחודש template, plus the
 * notes (unmapped components + free-text directives) that must travel beside
 * the file, per employee, in the accountant's language.
 */
function buildMovements(source) {
  const header = ['חודש עבודה', 'מספר עובד', 'סוג רשומה', 'קוד רכיב', 'תעריף', 'כמות'];
  const rows = [];
  const notes = [];
  const label = monthValue(source.month);

  for (const ce of source.ready) {
    const empNo = ce.employee.employee_number;

    // Base pay. Hourly → hours priced on שקלולית's side; global → the amount
    // our engine already prorated (their formula, our resolution — same number).
    const hourlyRate = Number(ce.rates?.hourly_rate) || 0;
    if (ce.employee.salary_type === 'hourly' && hourlyRate > 0) {
      const q = ce.quantities;
      if (q.regular_hours) rows.push([label, empNo, RECORD_TYPE.SALARY, HOURS.regular.code, hourlyRate, round2(q.regular_hours)]);
      if (q.ot_125_hours) rows.push([label, empNo, RECORD_TYPE.SALARY, HOURS.ot125.code, round2(hourlyRate * HOURS.ot125.factor), round2(q.ot_125_hours)]);
      if (q.ot_150_hours) rows.push([label, empNo, RECORD_TYPE.SALARY, HOURS.ot150.code, round2(hourlyRate * HOURS.ot150.factor), round2(q.ot_150_hours)]);
    } else if (ce.earnings.base_salary) {
      rows.push([label, empNo, RECORD_TYPE.SALARY, HOURS.regular.code, ce.earnings.base_salary, 1]);
      if (ce.employee.salary_type === 'hourly') {
        notes.push({
          employee_number: empNo, full_name: ce.employee.full_name,
          subject: 'שכר בסיס', text: 'עובד/ת שעתי/ת ללא תעריף שעה בכרטיס — נשלח כסכום במקום כשעות.',
        });
      }
    }

    if (ce.employee.salary_is_net) {
      notes.push({
        employee_number: empNo, full_name: ce.employee.full_name,
        subject: 'עובד/ת נטו', text: 'הסכומים בקובץ הם נטו לתשלום — הגילום אצלכם.',
      });
    }

    for (const comp of COMPONENTS) {
      const amount = Number(comp.get(ce)) || 0;
      if (!amount) continue; // a zero component is not a row
      const signed = (comp.sign === -1 ? -1 : 1) * Math.abs(amount);
      rows.push([label, empNo, comp.table || RECORD_TYPE.SALARY, comp.code, signed, 1]);
    }

    for (const comp of UNMAPPED) {
      const amount = Number(comp.get(ce)) || 0;
      if (!amount) continue;
      notes.push({
        employee_number: empNo,
        full_name: ce.employee.full_name,
        subject: comp.label,
        text: `₪${amount} — ${comp.hint}.`,
      });
    }

    const d = ce.directives;
    if (d.advance_deduction) {
      notes.push({
        employee_number: empNo, full_name: ce.employee.full_name,
        subject: 'ניכוי מקדמה (ניכוי רשות קוד 1; מפרעה = קוד 3)', text: d.advance_deduction,
      });
    }
    for (const [subject, text] of [
      ['נסיעות — הערה', d.travel_note],
      ['תו קנייה — הערה', d.gift_card_note],
      ['סיבוס — הערה', d.cibus_note],
      ['מילואים — הערה', d.miluim_note],
      ['הערות', d.notes],
    ]) {
      if (text) {
        notes.push({ employee_number: empNo, full_name: ce.employee.full_name, subject, text });
      }
    }
  }

  return { header, rows, notes };
}

const MASTER_HEADER = [
  'מספר זהות', 'מספר עובד', 'שם משפחה', 'שם פרטי', 'תאריך לידה',
  'תאריך תחילת עבודה', 'מין', 'מצב משפחתי', 'תאריך עלייה', 'מספר אישי בצה"ל',
  'תאריך תחילת שירות', 'תאריך סיום שירות', 'בנק-קוד בנק', 'בנק-קוד סניף',
  'בנק-מספר חשבון', 'תת מחלקה', 'הנחת יישובי פיתוח', 'קוד מיוחד - ביטוח לאומי',
  'קופת חולים',
];

/** Israeli convention on our cards: "פרטי משפחה". Best-effort split; the
 *  accountant sees both halves side by side and fixes the odd compound name. */
function splitName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/);
  if (parts.length <= 1) return { first: parts[0] || '', last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

const dateCell = (d) => {
  if (!d) return '';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${dt.getFullYear()}`;
};

/**
 * The employee master, per the נתוני עובד template. `extras` carries the
 * fields the canonical layer deliberately does not (birth/start/gender),
 * keyed by employee_number — the controller reads them off the Employee card.
 */
function buildMaster(source, extras = new Map()) {
  const rows = [];
  for (const ce of source.ready) {
    const { first, last } = splitName(ce.employee.full_name);
    const ex = extras.get(ce.employee.employee_number) || {};
    rows.push([
      ce.employee.israeli_id,
      ce.employee.employee_number,
      last,
      first,
      dateCell(ex.birth_date),
      dateCell(ex.start_date),
      ex.gender === 'male' ? 'זכר' : ex.gender === 'female' ? 'נקבה' : '',
      '', // מצב משפחתי — לא במערכת
      '', '', '', '', // עלייה / צה"ל — לא במערכת
      ce.employee.bank.code || '',
      ce.employee.bank.branch || '',
      ce.employee.bank.account || '',
      '', '', '', '', // תת מחלקה / יישובי פיתוח / ב"ל / קופ"ח — לרו"ח
    ]);
  }
  return { header: MASTER_HEADER, rows };
}

/**
 * The master row as named fields — the shape the snapshot stores, so a diff
 * speaks in column names ("בנק-מספר חשבון") rather than array indexes.
 * Only the columns WE fill are compared; the ones the accountant completes
 * on his side (מצב משפחתי, קופ"ח…) are not ours to report changes on.
 */
function masterRowToNamed(row) {
  const named = {};
  const TRACKED = [0, 1, 2, 3, 4, 5, 6, 12, 13, 14];
  for (const i of TRACKED) named[MASTER_HEADER[i]] = String(row[i] ?? '');
  return named;
}

/**
 * Diff the master against what the accountant already has (the snapshots).
 * Returns { new: [{employee_number, full_name}], changed: [{employee_number,
 * full_name, changes: [{column, before, after}]}], unchanged: N }.
 */
function masterDiff(master, snapshotByNumber) {
  const added = [];
  const changed = [];
  let unchanged = 0;
  for (const row of master.rows) {
    const named = masterRowToNamed(row);
    const empNo = named['מספר עובד'];
    const fullName = `${named['שם פרטי']} ${named['שם משפחה']}`.trim();
    const snap = snapshotByNumber.get(String(empNo));
    if (!snap) { added.push({ employee_number: empNo, full_name: fullName }); continue; }
    const changes = [];
    for (const [column, after] of Object.entries(named)) {
      const before = String(snap[column] ?? '');
      if (before !== after) changes.push({ column, before, after });
    }
    if (changes.length) changed.push({ employee_number: empNo, full_name: fullName, changes });
    else unchanged += 1;
  }
  return { new: added, changed, unchanged };
}

module.exports = {
  buildMovements,
  buildMaster,
  buildMasterDiff: masterDiff,
  masterRowToNamed,
  monthValue,
  RECORD_TYPE,
  COMPONENTS,
  HOURS,
  UNMAPPED,
  OPEN_QUESTIONS,
  _internals: { splitName, dateCell },
};
