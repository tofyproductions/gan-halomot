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
 * WHAT DOES NOT GO IN THE FILE. Components whose codes we still don't have
 * (cibus/meal value, gift card, loan/advance — they live in the EXTENDED
 * אקסולוגיה the accountant is sending) and every free-text directive are NOT
 * guessed into numeric rows. They come back from buildMovements() as `notes`
 * and land on a dedicated sheet the accountant reads.
 */

const OPEN_QUESTIONS = [
  '"סוג רשומה" — כנראה מבדיל בין שלוש טבלאות הקודים (רכיבי שכר / ניכויי רשות / זקופות); ממתינים לערכים מבית התוכנה. עד אז מקדמות וסיבוס בגיליון ההערות, עם הקוד ליד כל שורה.',
  'סיבוס: שווי ארוחות מופיע פעמיים באקסולוגיית הזקופות (קוד 2 וקוד 21) — לוודא איזה מהם בשימוש.',
  'החזר הלוואה: אין קוד ייעודי בניכויי הרשות — לוודא אם נקלט כמקדמה (קוד 1).',
  'חודש ניסיון: ספטמבר 2026 — הקבצים נשלחים לרו"ח במייל.',
];

/** "סוג רשומה" — the accountant: not in use. Sent empty until told otherwise. */
const RECORD_TYPE = '';

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
 * Components whose CODES are now known (the extended אקסולוגיה, 27.09.2026)
 * but whose "סוג רשומה" value is not — they live in the OTHER code tables
 * (ניכויי רשות / הכנסות זקופות), and until the software house says how the
 * movements file marks those tables, they ride the notes sheet WITH their
 * code, so the accountant keys them in seconds.
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

/** 'YYYY-MM' → 'MM/YYYY' (the shape a Hebrew payroll clerk reads; to confirm). */
function monthLabel(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  return m ? `${m[2]}/${m[1]}` : String(month || '');
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
  const label = monthLabel(source.month);

  for (const ce of source.ready) {
    const empNo = ce.employee.employee_number;

    // Base pay. Hourly → hours priced on שקלולית's side; global → the amount
    // our engine already prorated (their formula, our resolution — same number).
    const hourlyRate = Number(ce.rates?.hourly_rate) || 0;
    if (ce.employee.salary_type === 'hourly' && hourlyRate > 0) {
      const q = ce.quantities;
      if (q.regular_hours) rows.push([label, empNo, RECORD_TYPE, HOURS.regular.code, hourlyRate, round2(q.regular_hours)]);
      if (q.ot_125_hours) rows.push([label, empNo, RECORD_TYPE, HOURS.ot125.code, round2(hourlyRate * HOURS.ot125.factor), round2(q.ot_125_hours)]);
      if (q.ot_150_hours) rows.push([label, empNo, RECORD_TYPE, HOURS.ot150.code, round2(hourlyRate * HOURS.ot150.factor), round2(q.ot_150_hours)]);
    } else if (ce.earnings.base_salary) {
      rows.push([label, empNo, RECORD_TYPE, HOURS.regular.code, ce.earnings.base_salary, 1]);
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
      rows.push([label, empNo, RECORD_TYPE, comp.code, signed, 1]);
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

module.exports = {
  buildMovements,
  buildMaster,
  monthLabel,
  RECORD_TYPE,
  COMPONENTS,
  HOURS,
  UNMAPPED,
  OPEN_QUESTIONS,
  _internals: { splitName, dateCell },
};
