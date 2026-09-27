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
 * THE AMOUNT RULE. Until the accountant confirms which components שקלולית
 * expects as quantities (rate × qty computed on their side), EVERY component
 * is emitted as a resolved amount: תעריף = the shekel figure our screen pays,
 * כמות = 1. This is the only mode that cannot double-pay or re-price anything,
 * because the amount is copied from the field the on-screen payroll already
 * shows. Switching a component to quantity mode later is a one-line change in
 * COMPONENTS below — never a recalculation.
 *
 * WHAT DOES NOT GO IN THE FILE. Components with no code in the אקסולוגיה
 * (cibus, gift card, meal vouchers, loan/advance deductions) and every
 * free-text directive are NOT guessed into a numeric row. They come back from
 * buildMovements() as `notes` — the adapter's caller shows them to the person
 * sending the file, and they land on a dedicated sheet the accountant reads.
 */

const OPEN_QUESTIONS = [
  'ערכי "סוג רשומה" טרם אושרו מול הרו"ח — כרגע נשלח 1 בכל שורה.',
  'כל הרכיבים נשלחים כסכום (תעריף=סכום, כמות=1) עד לאישור אילו רכיבים נקלטים ככמויות.',
  'שעות נוספות אינן נשלחות בנפרד (קודים 32/33) — הן כלולות בשכר הבסיס שלנו.',
];

/** "סוג רשומה" — open question; 1 until the accountant says otherwise. */
const RECORD_TYPE = 1;

/**
 * The component map: canonical field → שקלולית code (אקסולוגיה, חברה 600).
 * `sign` -1 marks a deduction, emitted as a negative amount so it cannot be
 * misread as pay — flip to +1 if the trial import shows שקלולית expects
 * positives on deduction codes.
 */
const COMPONENTS = [
  { key: 'base_salary', code: 1, label: 'שכר יסוד', get: (ce) => ce.earnings.base_salary },
  { key: 'salary_completion', code: 38, label: 'השלמת שכר', get: (ce) => ce.earnings.salary_completion },
  { key: 'travel', code: 3, label: 'נסיעות', get: (ce) => ce.earnings.travel },
  { key: 'recreation', code: 4, label: 'הבראה', get: (ce) => ce.earnings.recreation },
  { key: 'holiday_pay', code: 44, label: 'ימי חג', get: (ce) => ce.earnings.holiday_pay },
  { key: 'sick_pay', code: 34, label: 'ימי מחלה', get: (ce) => ce.earnings.sick_pay },
  { key: 'bonus', code: 35, label: 'בונוס', get: (ce) => ce.earnings.bonus },
  { key: 'august_bonus', code: 39, label: 'בונוס מיוחד (מענק אוגוסט)', get: (ce) => ce.earnings.august_bonus },
  { key: 'miluim', code: 42, label: 'ימי מילואים', get: (ce) => ce.earnings.miluim },
  { key: 'absence', code: 36, label: 'ימים חסרים', sign: -1, get: (ce) => ce.deductions.absence },
  { key: 'partial_absence', code: 41, label: 'שעות חסרות', sign: -1, get: (ce) => ce.deductions.partial_absence },
];

/** Components we PAY but have no שקלולית code yet — surfaced, never guessed. */
const UNMAPPED = [
  { key: 'meal_vouchers', label: 'תווי מזון / כלכלה', get: (ce) => ce.earnings.meal_vouchers },
  { key: 'cibus', label: 'סיבוס', get: (ce) => ce.earnings.cibus },
  { key: 'gift_card', label: 'תו קנייה (גיפט קארד)', get: (ce) => ce.earnings.gift_card },
  { key: 'loans', label: 'ניכוי הלוואה', get: (ce) => ce.deductions.loans },
];

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
        text: `₪${amount} — אין קוד רכיב בשקלולית, לקליטה ידנית.`,
      });
    }

    const d = ce.directives;
    if (d.advance_deduction) {
      notes.push({
        employee_number: empNo, full_name: ce.employee.full_name,
        subject: 'ניכוי מקדמה', text: d.advance_deduction,
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
  UNMAPPED,
  OPEN_QUESTIONS,
  _internals: { splitName, dateCell },
};
