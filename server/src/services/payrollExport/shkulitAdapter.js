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
  'תווי מזון: סיבוס אושר כזקופות 21 — לוודא אם תווי מזון נקלטים באותו קוד. עד אז נשארים בגיליון ההערות.',
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
  ATTENDANCE: 4,         // היעדרויות ונתוני העסקה
});

/**
 * סוג רשומה 4 — היעדרויות ונתוני העסקה, per ט.מ.ל.'s own import spec
 * (docs/payroll-export/מבנה-קובץ-העברת-נתוני-נוכחות-לשיקלולית.pdf).
 *
 * This is the table that answers what none of the salary codes could: how to
 * report that days were USED without paying for them. The spec is explicit —
 * "בסוג רשומה 4 או 7 - התעריף לא רלוונטי", and the quantity is a positive
 * number. So a row here is a COUNT and nothing else.
 *
 * It is the reason ניצול חופשה stayed at 0.000 all month: the count was being
 * sent as a salary component (table 1, code 8), which pays money and is not
 * where שקלולית keeps its attendance figures. Code 8 in THIS table means
 * something else again — שעות עבודה משולמות — which is exactly the kind of
 * collision that makes a number look filed when it is not.
 */
const ATTENDANCE = Object.freeze({
  VACATION_USED: 1,   // ניצול חופשה
  SICK_USED: 2,       // ניצול מחלה
  RESERVE_DAYS: 3,    // ימי מילואים
  WORK_DAYS_PAID: 4,  // ימי עבודה משולמים
  WORK_HOURS: 5,      // שעות עבודה בפועל
  DAILY_TAX_DAYS: 6,  // ימים למ.ה — עובד יומי
  WORK_DAYS_ACTUAL: 7, // ימי עבודה בפועל
  WORK_HOURS_PAID: 8, // שעות עבודה משולמות
});

/**
 * The component map: canonical field → שקלולית code (אקסולוגיה, חברה 600).
 * `sign` -1 marks a deduction, emitted as a negative amount so it cannot be
 * misread as pay — flip to +1 if the trial import shows שקלולית expects
 * positives on deduction codes.
 */
/**
 * Amount components. Base salary is handled apart.
 *
 * `units` marks a component that is COUNTED as well as paid — days of חג, days
 * of מחלה, hours missing. For those, "כמות 1 × the whole amount" is wrong on
 * the תלוש even when the money is right: רינת's two days of חג went out on
 * 09.2026 as כמות 1 / תעריף 622.36, and the payslip then said she had one day
 * of חג. The count is what the employee reads and what an audit counts, so
 * these are emitted as תעריף-per-unit × כמות instead.
 *
 * `sign` -1 marks a deduction, emitted as a negative amount so it cannot be
 * misread as pay.
 */
/**
 * ימי חג — code 44. Named rather than inlined because it is also the one code
 * we file a deliberate ZERO for when an employee is not entitled; see the
 * switch-off block at the end of buildMovements.
 */
const HOLIDAY_CODE = 44;

const COMPONENTS = [
  // Two DIFFERENT completions, two DIFFERENT codes — confirmed with the user
  // 28.09.2026: code 47 is the AUTOMATIC תקן completion (calculateMonthlySalary's
  // tb.completion, the standing weekly top-up); code 38 is a manual ONE-OFF
  // completion the accountant enters for this month only (e.g. hours from a
  // prior month that missed that month's report). They used to share code 38,
  // which conflated the two on the payslip.
  { key: 'salary_completion', code: 47, label: 'השלמת שכר', get: (ce) => ce.earnings.salary_completion },
  { key: 'one_time_salary_completion', code: 38, label: 'השלמת שכר חד פעמית', get: (ce) => ce.earnings.one_time_salary_completion },
  // תוספת שעות מעל התקן — code 31, confirmed with the user 29.09.2026.
  //
  // A תקן employee's salary components are capped at the agreed salary, so
  // hours worked PAST the commitment cannot ride inside them — they are money
  // owed on top. ליאור מחפוד, 09.2026: 28.9 approved hours worth ₪1,829, shown
  // on her card and counted in her estimated total, and absent from the file.
  // Filed per-hour × quantity when the rate divides exactly, like any other
  // counted component, so the payslip states the hours and not just the money.
  { key: 'extra_hours', code: 31, label: 'תוספת שעות מעל התקן', unit: 'שעות',
    get: (ce) => ce.earnings.extra_hours_pay, units: (ce) => ce.quantities.extra_hours },
  { key: 'travel', code: 3, label: 'נסיעות', get: (ce) => ce.earnings.travel },
  { key: 'holiday_pay', code: HOLIDAY_CODE, label: 'ימי חג', unit: 'ימים', get: (ce) => ce.earnings.holiday_pay, units: (ce) => ce.quantities.holiday_days },
  { key: 'sick_pay', code: 34, label: 'ימי מחלה', unit: 'ימים', get: (ce) => ce.earnings.sick_pay, units: (ce) => ce.quantities.sick_days },
  // בונוס — code 35, and בונוס אוגוסט rides the SAME code.
  //
  // 39 "בונוס מיוחד" exists in the אקסולוגיה and was the guess here, written
  // with a "(לוודא)" beside it in the checklist and never verified. אילנה
  // שימחי's 08.2026 payslip settles it: her ₪1,844 sits on a line named
  // "בונוס" — the accountant's own hand, code 35. Filing 39 would have left
  // her real bonus standing under 35 with a zero sent to an empty 39.
  //
  // The two are SUMMED rather than sent as two rows: one code twice leaves
  // שקלולית to decide whether to add them or keep the last, and neither answer
  // is written down anywhere. What the row contains is said in the notes.
  { key: 'bonus', code: 35, label: 'בונוס',
    get: (ce) => round2((Number(ce.earnings.bonus) || 0)
      + (Number(ce.earnings.one_time_bonus) || 0)
      + (Number(ce.earnings.august_bonus) || 0)) },
  { key: 'miluim', code: 42, label: 'ימי מילואים', get: (ce) => ce.earnings.miluim },
  { key: 'absence', code: 36, label: 'ימים חסרים', sign: -1, unit: 'ימים', get: (ce) => ce.deductions.absence, units: (ce) => ce.quantities.absence_deduct_days },
  { key: 'partial_absence', code: 41, label: 'שעות חסרות', sign: -1, unit: 'שעות', get: (ce) => ce.deductions.partial_absence, units: (ce) => ce.quantities.partial_absence_hours },
  // שי לחג — confirmed 28.09.2026: סוג רשומה 2 (הכנסות זקופות), קוד 22.
  // The first code in this file that arrived confirmed rather than guessed,
  // which is why it is a row here instead of a line on the notes sheet.
  { key: 'gift_card', code: 22, table: RECORD_TYPE.IMPUTED, label: 'שי לחג', get: (ce) => ce.earnings.gift_card },
  // סיבוס — confirmed 28.09.2026: סוג רשומה 2 (הכנסות זקופות), קוד 21.
  // The אקסולוגיה listed שווי ארוחות twice, as 2 and as 21, and that ambiguity
  // is what kept it on the notes sheet; 21 is the one in use.
  { key: 'cibus', code: 21, table: RECORD_TYPE.IMPUTED, label: 'סיבוס', get: (ce) => ce.earnings.cibus },
];


/**
 * תמורת חופשה — code 8 in the אקסולוגיה, confirmed 28.09.2026.
 * (Code 7 is פדיון חופשה, the redemption paid out at the end of employment —
 * a different event, and not something this monthly file ever emits.)
 */
const VACATION_CODE = 8;

/**
 * הבראה — code 4 of the salary table. Never filed as a row (the accountant
 * computes it by job scope), but it is on the payslip, so it has to be
 * switched off the month after — see `recreation_on_payslip`.
 */
const RECREATION_CODE = 4;

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
  // תווי מזון is NOT assumed to share סיבוס's code. Both sit under שווי ארוחות
  // in the אקסולוגיה, but only סיבוס was confirmed as 21 — and "probably the
  // same line" is the reasoning that put a work-day count under הבראה.
  { key: 'meal_vouchers', label: 'תווי מזון / כלכלה', table: RECORD_TYPE.IMPUTED, hint: 'זקופות — שווי ארוחות. סיבוס אושר כ-21; לוודא אם תווי מזון נקלטים באותו קוד', get: (ce) => ce.earnings.meal_vouchers },
  { key: 'loans', label: 'ניכוי הלוואה', table: RECORD_TYPE.VOLUNTARY_DEDUCTION, sign: -1, hint: 'ניכוי רשות — כנראה כמקדמה (קוד 1), לוודא', get: (ce) => ce.deductions.loans },
  // הבראה — the accountant computes it by job scope; when our table carries
  // an amount anyway, it is surfaced so nobody pays it twice.
  { key: 'recreation', label: 'הבראה', hint: 'מחושבת אצל הרו"ח לפי היקף משרה — לידיעה בלבד', get: (ce) => ce.earnings.recreation },
];

const round2 = (n) => Math.round(n * 100) / 100;
const round3 = (n) => Math.round(n * 1000) / 1000;

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
function buildMovements(source, previousByEmployee = new Map(), componentCodes = {}, alwaysZero = []) {
  const codes = componentCodes || {};
  const header = ['חודש עבודה', 'מספר עובד', 'סוג רשומה', 'קוד רכיב', 'תעריף', 'כמות'];
  const rows = [];
  const notes = [];
  const label = monthValue(source.month);
  // What each employee's file actually contained, so the caller can record it
  // and next month knows which components to switch off.
  const filed = new Map();

  for (const ce of source.ready) {
    const empNo = ce.employee.employee_number;

    // Every row this employee gets is recorded as it is pushed, so the caller
    // can remember the set and next month can switch off whatever leaves it.
    // A zero row is deliberately NOT recorded — it is the switch-off itself,
    // and remembering it would mean re-sending a zero for a component nobody
    // is filing any more, for ever.
    const mine = [];
    filed.set(empNo, mine);
    const push = (table, code, rate, qty) => {
      rows.push([label, empNo, table, code, rate, qty]);
      if (rate !== 0 || qty !== 0) mine.push({ code, table });
    };

    /**
     * A rate × quantity row that must still come to `expected` to the agora.
     *
     * שקלולית multiplies the two columns on its side, so whichever one we round
     * for readability changes the money. One of the two is the number a person
     * actually reads — 7.1 hours, a מקדם of 0.746 — and that one is held fixed
     * while the OTHER is lengthened until the product lands on the amount.
     *
     * `keep` says which is the readable one. For overtime it is the quantity:
     * the payslip says 7.1 hours and the file must say 7.1 hours, so the hourly
     * rate carries the extra decimals. For a תקן salary it is the rate: the
     * agreed ₪10,300 has to be recognisable, so the מקדם carries them.
     *
     * If nothing we are willing to send reproduces the amount, the row falls
     * back to the plain figure at quantity 1 and says so. A file that pays the
     * right money and explains itself beats one that reads nicely and underpays
     * — ליאור's מקדם at three decimals is ₪1.20 short of her payslip.
     */
    const pushExact = (table, code, rate, qty, expected, keep, what, human) => {
      const target = round2(expected);
      const tryRow = (r, q) => round2(r * q) === target;
      const fixed = keep === 'qty' ? round2(qty) : round2(rate);
      // Up to seven places: ליאור's מקדם needs 0.7461165 to land on ₪7,685
      // exactly, and six places is still four agorot out.
      for (const dp of [2, 3, 4, 5, 6, 7]) {
        const flex = Number((keep === 'qty' ? rate : qty).toFixed(dp));
        const r = keep === 'qty' ? flex : fixed;
        const q = keep === 'qty' ? fixed : flex;
        if (tryRow(r, q)) { push(table, code, r, q); return; }
      }
      push(table, code, target, 1);
      notes.push({
        employee_number: empNo, full_name: ce.employee.full_name,
        subject: what,
        text: `${human}. הכמות לא מתחלקת בדיוק, ולכן נשלח הסכום המלא ${target} בכמות 1 כדי לא לשנות את השכר.`,
      });
    };

    // Base pay. Hourly → hours priced on שקלולית's side; global → the amount
    // our engine already prorated (their formula, our resolution — same number).
    const hourlyRate = Number(ce.rates?.hourly_rate) || 0;
    if (ce.employee.salary_type === 'hourly' && hourlyRate > 0) {
      const q = ce.quantities;
      if (q.regular_hours) push(RECORD_TYPE.SALARY, HOURS.regular.code, hourlyRate, round2(q.regular_hours));
      if (q.ot_125_hours) push(RECORD_TYPE.SALARY, HOURS.ot125.code, round2(hourlyRate * HOURS.ot125.factor), round2(q.ot_125_hours));
      if (q.ot_150_hours) push(RECORD_TYPE.SALARY, HOURS.ot150.code, round2(hourlyRate * HOURS.ot150.factor), round2(q.ot_150_hours));
    } else if (ce.earnings.teken_regular || ce.earnings.teken_ot125 || ce.earnings.teken_ot150
      // A תקן split with NOTHING worked is still a תקן split. טטיאנה
      // אייזנשטט, 09.2026 — six days of חופשה, fifteen absent, no hours: all
      // three parts were zero, so this fell through to base_salary and filed
      // 8,500 under code 1 — while base_salary already IS the completion, and
      // the completion went out again under code 47. ₪17,000 for ₪8,500.
      // Here, nothing goes under code 1 and the completion carries the salary.
      || (ce.employee.salary_type === 'global' && Number(ce.earnings.teken_salary) > 0)) {
      // A תקן employee is filed the way her payslip reads: the full agreed
      // salary times its מקדם, and the hourly value times the overtime hours.
      //
      // Not as a bare total. ליאור מחפוד worked 129.9 of 162.5 committed hours,
      // מקדם 0.746, and her card says so — but a row reading "10,300 × 1" hides
      // both the shortfall and the completion that covers it, and a row reading
      // "7,685 × 1" hides where 7,685 came from. Neither can be checked against
      // the payslip by the person whose salary it is.
      //
      // The quantity is derived from the AMOUNT rather than from the raw hours,
      // because both components are capped at the agreed salary: when a month's
      // overtime spills past the basket, the hours worked and the hours paid
      // stop being the same number, and it is the paid one that belongs in a
      // payroll file.
      const t = ce.earnings;
      const salary = round2(Number(t.teken_salary) || 0);
      const hv = Number(t.teken_hourly_value) || 0;

      if (t.teken_regular) {
        if (salary > 0) {
          const factor = t.teken_regular / salary;   // the מקדם תקן, as the payslip prints it
          // The agreed salary must stay recognisable, so the מקדם flexes.
          pushExact(RECORD_TYPE.SALARY, HOURS.regular.code, salary, factor, t.teken_regular,
            'rate', 'שכר יסוד', `מקדם תקן ${round3(factor)} על שכר ${salary}`);
        } else {
          push(RECORD_TYPE.SALARY, HOURS.regular.code, t.teken_regular, 1);
        }
      }
      for (const [amount, spec, label] of [
        [t.teken_ot125, HOURS.ot125, 'שע״נ 125%'],
        [t.teken_ot150, HOURS.ot150, 'שע״נ 150%'],
      ]) {
        if (!amount) continue;
        const rate = round2(hv * spec.factor);
        if (rate > 0) {
          // The hours are what the payslip states, so the rate flexes.
          const hours = round2(amount / rate);
          pushExact(RECORD_TYPE.SALARY, spec.code, amount / hours, hours, amount,
            'qty', label, `${hours} שעות × ${rate}`);
        } else {
          push(RECORD_TYPE.SALARY, spec.code, amount, 1);
        }
      }
    } else if (ce.earnings.base_salary) {
      push(RECORD_TYPE.SALARY, HOURS.regular.code, ce.earnings.base_salary, 1);
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
      const sign = comp.sign === -1 ? -1 : 1;
      const gross = Math.abs(amount);
      const table = comp.table || RECORD_TYPE.SALARY;
      const units = comp.units ? round2(Number(comp.units(ce)) || 0) : 0;

      // The count only goes out when the per-unit rate reproduces the amount
      // EXACTLY. שקלולית multiplies תעריף × כמות on its side, so a rate that
      // does not divide evenly (100 over 3 days → 33.33 × 3 = 99.99) would pay
      // a different number than our table says. A payslip that undercounts days
      // is a complaint; a payslip that underpays is a wage claim. So when the
      // split is not exact the amount travels whole, and the real count is told
      // to the accountant in words instead of being quietly rounded into money.
      const perUnit = units > 0 ? round2(gross / units) : 0;
      const exact = units > 1 && perUnit > 0 && round2(perUnit * units) === round2(gross);

      if (exact) {
        push(table, comp.code, sign * perUnit, units);
      } else {
        push(table, comp.code, sign * gross, 1);
        if (units > 1) {
          notes.push({
            employee_number: empNo, full_name: ce.employee.full_name,
            subject: comp.label,
            text: `${units} ${comp.unit || 'יחידות'} בסך ${round2(gross)} ש״ח. הסכום לא מתחלק בדיוק ליחידה, לכן השורה נשלחה ככמות 1 עם הסכום המלא — הכמות בתלוש תצטרך תיקון ידני.`,
          });
        }
      }
    }

    // What the single בונוס row is made of, whenever it is not just a bonus.
    // The accountant reads one number under code 35 and has no way to see that
    // part of it is חופשת הקיץ; this is the only place that can tell them.
    const augBonus = round2(Number(ce.earnings.august_bonus) || 0);
    if (augBonus > 0) {
      const plain = round2(Number(ce.earnings.bonus) || 0);
      notes.push({
        employee_number: empNo, full_name: ce.employee.full_name,
        subject: 'בונוס אוגוסט',
        text: plain > 0
          ? `שורת בונוס (קוד 35) מכילה ${plain} ש״ח בונוס רגיל + ${augBonus} ש״ח בונוס אוגוסט (ימי חופשת קיץ בתשלום) = ${round2(plain + augBonus)} ש״ח.`
          : `שורת בונוס (קוד 35) בסך ${augBonus} ש״ח היא בונוס אוגוסט — ימי חופשת קיץ בתשלום.`,
      });
    }

    // בונוס חד פעמי rides the same code 35 row as the standing בונוס — same
    // reasoning as בונוס אוגוסט above: one code, so the notes say what it holds.
    const oneTimeBonus = round2(Number(ce.earnings.one_time_bonus) || 0);
    if (oneTimeBonus > 0) {
      const standing = round2(Number(ce.earnings.bonus) || 0);
      notes.push({
        employee_number: empNo, full_name: ce.employee.full_name,
        subject: 'בונוס חד פעמי',
        text: standing > 0
          ? `שורת בונוס (קוד 35) מכילה ${standing} ש״ח בונוס קבוע + ${oneTimeBonus} ש״ח בונוס חד פעמי = ${round2(standing + oneTimeBonus)} ש״ח.`
          : `שורת בונוס (קוד 35) בסך ${oneTimeBonus} ש״ח היא בונוס חד פעמי.`,
      });
    }

    // ימי חופשה — code 8, תמורת חופשה (אקסולוגיה, אושר 28.09.2026).
    //
    // One row carries BOTH facts the payslip needs: how many days were used,
    // and what was paid for them. Quantity is the days; rate is the daily rate.
    //
    // And the rate is where a תקן employee differs from an hourly one, which is
    // the whole reason this is not a single formula:
    //
    //   HOURLY — the days are paid. Rate = the pay divided by the days, so the
    //   row reads as a daily rate and comes to the money the table says.
    //
    //   תקן — the days are USED but not paid. Her salary does not move with
    //   them; it already contains them. So the rate is 0: the row tells
    //   שקלולית to draw the days from her balance and add nothing. Filing a
    //   rate here would pay her the same leave twice — once inside the agreed
    //   salary and once beside it.
    //
    // The days themselves were already capped (hourly) or allowed to overdraw
    // (תקן) in the source layer, so what arrives here is what may be filed.
    const vacDays = round2(Number(ce.quantities?.vacation_days) || 0);
    const vacTaken = round2(Number(ce.quantities?.vacation_days_taken) || 0);
    const vacPay = round2(Number(ce.earnings?.vacation_pay) || 0);
    const vacIsGlobal = ce.employee.salary_type === 'global';

    // ── the count, in the table that holds counts ───────────────────────────
    //
    // ניצול חופשה is סוג רשומה 4, קוד 1, and the spec says the rate is not
    // relevant there. That is the answer to a month of guessing: the days were
    // being sent as a salary component, which pays money and never touches the
    // attendance figures, so the payslip showed תמורת חופשה paid and ניצול
    // חופשה at 0.000 at the same time.
    //
    // Both kinds of employee report the count. Only an hourly one is also PAID
    // for it, below — and the two are now separate rows in separate tables,
    // which is what they always were.
    if (vacDays > 0) {
      push(RECORD_TYPE.ATTENDANCE, ATTENDANCE.VACATION_USED, 0, vacDays);
    }
    const sickDaysUsed = round2(Number(ce.quantities?.sick_days) || 0);
    if (sickDaysUsed > 0) {
      push(RECORD_TYPE.ATTENDANCE, ATTENDANCE.SICK_USED, 0, sickDaysUsed);
    }
    // ימי מילואים: the count goes to the attendance table, the ₪ stays a
    // salary component (code 42). Two figures about the same absence, and
    // שקלולית keeps them apart.
    const miluimDays = round2(Number(ce.quantities?.miluim_days) || 0);
    if (miluimDays > 0) {
      push(RECORD_TYPE.ATTENDANCE, ATTENDANCE.RESERVE_DAYS, 0, miluimDays);
    }

    // ── the money, for an hourly employee only ──────────────────────────────
    //
    // A תקן salary does not move with the days; it already contains them, so
    // there is nothing to pay beside it. An hourly employee is paid, and the
    // row carries the daily rate.
    if (vacDays > 0 && vacPay > 0 && !vacIsGlobal) {
      pushExact(RECORD_TYPE.SALARY, VACATION_CODE, vacPay / vacDays, vacDays, vacPay,
        'qty', 'תמורת חופשה', `${vacDays} ימי חופשה בתשלום`);
    } else if (vacDays > 0 && !vacIsGlobal) {
      // The days leave her balance above, and nothing pays for them — an hourly
      // employee whose day came out worth ₪0 (no rate on the card, no history).
      // נועה אביב, 09.2026: 2.74 days drawn, ₪0 paid. Said out loud rather
      // than filed silently.
      notes.push({
        employee_number: empNo, full_name: ce.employee.full_name,
        subject: 'ימי חופשה ללא תשלום (לבדיקה)',
        text: `${vacDays} ימי חופשה נרשמו כניצול, אך שווי יום החופשה חושב כ-0 ולכן לא נשלח תשלום (קוד 8). כנראה חסר תעריף שעתי או היסטוריית שכר בכרטיס העובד/ת.`,
      });
    }

    if (ce.quantities?.vacation_override_applied) {
      // Accounting explicitly lifted the balance cap for THIS employee, this
      // month — vacTaken === vacDays now (nothing capped), so the condition
      // below would stay silent. That silence would read as "nothing unusual
      // happened", when an exception was made — worth its own note either way.
      notes.push({
        employee_number: empNo, full_name: ce.employee.full_name,
        subject: 'ימי חופשה — אישור הנה״ח',
        text: `${vacDays} ימי חופשה שולמו במלואם למרות שהיתרה (${round2(Number(ce.quantities.vacation_balance_available) || 0)}) לא כיסתה אותם — הנהלת חשבונות אישרה תשלום מלא בכל זאת.`,
      });
    } else if (vacTaken > vacDays || ce.quantities?.vacation_overdraft_days) {
      // Only worth a note when the days absent and the days filed differ.
      notes.push({
        employee_number: empNo, full_name: ce.employee.full_name,
        subject: 'ימי חופשה',
        text: ce.quantities?.vacation_capped
          ? `${vacDays} ימים לתשלום — מוגבל ליתרה. בפועל נעדרה ${vacTaken} ימים, והיתרה בתחילת החודש הייתה ${round2(Number(ce.quantities.vacation_balance_available) || 0)}. ${round2(ce.quantities.vacation_days_unpaid)} ימים נותרו ללא תשלום עד להחלטת המשרד.`
          : `${vacDays} ימי חופשה, מתוכם ${round2(ce.quantities.vacation_overdraft_days)} מעבר ליתרה. עובדת תקן — שולמו במסגרת השכר, והיתרה נכנסת למינוס לקיזוז בגמר חשבון.`,
      });
    }

    // ── ימי עבודה ושעות עבודה ───────────────────────────────────────────────
    //
    // Two different counts, and שקלולית keeps a separate code for each:
    //
    //   קוד 4  ימי עבודה משולמים — every day she was PAID for
    //   קוד 7  ימי עבודה בפועל   — the days she actually worked
    //
    // Only the second was being filed, under the first one's code. מהרט worked
    // two days and was paid for two more of חופשה, and her payslip read
    // "ימים משולמים 2, בפועל 2" — the two paid days of leave were nowhere, so
    // the payslip disagreed with its own תמורת חופשה line.
    //
    // (This is also the table where קוד 4 belongs at all: קוד 4 of the SALARY
    // table is הבראה, and an earlier attempt to file work days there surfaced
    // as a recreation line.)
    const daysWorked = round2(Number(ce.quantities?.days_worked) || 0);
    const q = ce.quantities || {};
    const daysPaid = round2(
      daysWorked
      + (Number(q.vacation_days) || 0)    // the FILED days, already capped
      + (Number(q.sick_days) || 0)
      + (Number(q.holiday_days) || 0)
      + (Number(q.miluim_days) || 0),
    );
    if (daysPaid > 0) {
      push(RECORD_TYPE.ATTENDANCE, ATTENDANCE.WORK_DAYS_PAID, 0, daysPaid);
    }
    // Filed whenever it differs from the paid count — INCLUDING when it is
    // zero. An employee who took no leave has one number for both, and two
    // identical rows only invite the reader to wonder which is authoritative;
    // but fourteen employees this month worked no days at all — the whole
    // month was חופשה or מחלה — and saying nothing about them leaves a payslip
    // that reads as though they worked every paid day.
    if (daysPaid > 0 && daysWorked !== daysPaid) {
      push(RECORD_TYPE.ATTENDANCE, ATTENDANCE.WORK_DAYS_ACTUAL, 0, daysWorked);
    }

    const workedHours = round2(Number(ce.quantities?.worked_hours) || 0);
    if (workedHours > 0) {
      push(RECORD_TYPE.ATTENDANCE, ATTENDANCE.WORK_HOURS, 0, workedHours);
    }
    // שעות עבודה משולמות — the other half of the payslip's "משולמות / בפועל".
    //
    // Never filed until 29.09.2026, so שקלולית carried August's figure into
    // September: אסתר הרוניאן's payslip read 78.8 paid hours beside 92.22
    // worked, with six paid days of חופשה nowhere in it; אילנה שימחי's read
    // 60.25. The worked hours were right — it was the paid ones nobody sent.
    const paidHours = ce.quantities?.paid_hours == null ? 0 : round2(Number(ce.quantities.paid_hours) || 0);
    if (paidHours > 0) {
      push(RECORD_TYPE.ATTENDANCE, ATTENDANCE.WORK_HOURS_PAID, 0, paidHours);
    }

    for (const comp of UNMAPPED) {
      const raw = Number(comp.get(ce)) || 0;
      if (!raw) continue;
      const code = Number(codes[comp.key]) || 0;
      if (code > 0) {
        const sign = comp.sign === -1 ? -1 : 1;
        push(comp.table || RECORD_TYPE.SALARY, code, sign * Math.abs(raw), 1);
        continue;
      }
      notes.push({
        employee_number: empNo,
        full_name: ce.employee.full_name,
        subject: comp.label,
        text: `₪${raw} — ${comp.hint}.`,
      });
    }

    // Lines the accountant keys by hand still sit on the payslip, and שקלולית
    // carries them forward like any other. Remembered as filed — without a row
    // — so next month's file switches them off. Only codes that are CONFIRMED
    // belong here; an unconfirmed code zeroed is a stranger's line wiped.
    if (ce.flags?.recreation_on_payslip
      && !mine.some((c) => c.code === RECREATION_CODE && (c.table || RECORD_TYPE.SALARY) === RECORD_TYPE.SALARY)) {
      mine.push({ code: RECREATION_CODE, table: RECORD_TYPE.SALARY });
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
      ['הבראה — הערה', d.recreation_note],
      ['דמי חגים — לא שולמו (לבדיקה)', d.holidays_not_paid],
      ['הערות', d.notes],
    ]) {
      if (text) {
        notes.push({ employee_number: empNo, full_name: ce.employee.full_name, subject, text });
      }
    }
  }

  // ── switching off what should not carry forward ─────────────────────────
  //
  // שקלולית carries a payslip forward: a component that was on last month's
  // payslip and is missing from this month's file is not dropped, it is kept at
  // last month's value and PAID AGAIN. That is how הבראה — paid once a year, in
  // August — turns up in September, and how last month's 150% overtime keeps
  // paying an employee who worked none.
  //
  // Two sources of such rows, and they need different treatment:
  //
  //   WHAT WE FILED. Remembered per employee, so anything that leaves our file
  //   is switched off automatically. Safe, because a component we stopped
  //   filing is one we know is not due.
  //
  //   WHAT WE NEVER FILED. This is what started the list: ליאור's קוד 47
  //   (השלמת שכר על ידי מעביד) sat in her September payslip at August's
  //   ₪3,791 — back when we never sent code 47 at all, so it was never in our
  //   snapshot and nothing here could reach it. As of 28.09.2026 code 47 IS
  //   one we file (the automatic תקן completion — see shkulitAdapter's
  //   COMPONENTS), so it now falls under "WHAT WE FILED" above instead. This
  //   list stays for any OTHER code we still don't file but שקלולית might
  //   carry forward — named by hand, in the settings screen.
  //
  //   ⚠️ A code on that list is zeroed EVERY month it is not filed by us. If
  //   the accountant enters it deliberately one month, this wipes it. That is
  //   the trade being made, and it is why the list is a deliberate act rather
  //   than a default.
  //
  // Nothing on either list can zero a component we ARE filing this month — the
  // filed set is checked first, so an always-zero code that becomes ours simply
  // stops being zeroed.
  const alwaysZeroList = (alwaysZero || [])
    .map((z) => ({ code: Number(z.code), table: Number(z.table) || RECORD_TYPE.SALARY }))
    .filter((z) => Number.isFinite(z.code) && z.code > 0);

  for (const ce of source.ready) {
    const empNo = ce.employee.employee_number;
    const nowFiled = filed.get(empNo) || [];
    const nowCodes = new Set(nowFiled.map((c) => `${c.table}:${c.code}`));
    const key = (p) => `${p.table || RECORD_TYPE.SALARY}:${p.code}`;

    const previous = previousByEmployee.get(String(empNo)) || [];
    const stale = previous.filter((p) => !nowCodes.has(key(p)));
    const staleKeys = new Set(stale.map(key));
    // Named codes that are neither filed by us nor already being switched off.
    const standing = alwaysZeroList.filter((z) => !nowCodes.has(key(z)) && !staleKeys.has(key(z)));

    //   DENIED דמי חגים. The third source, and the one neither list above can
    //   reach: a code we have never filed for her, because she has never been
    //   entitled to it. Nothing we filed went stale, and nobody named 44 in
    //   the settings screen — so the ordinary machinery has no reason to touch
    //   it, and שקלולית quietly keeps paying whatever her payslip last carried.
    //   גלאם רות, 09.2026: not entitled to any of the month's four holidays
    //   (26 days of seniority against 90), no row from us, and the accountant
    //   reported after the import that she was receiving דמי חגים.
    //
    //   A zero is honest here in a way a blanket zero would not be: the engine
    //   was asked about her holidays this month and answered no. An office that
    //   wants to pay her regardless types an amount into the table's דמי חגים
    //   field, which files a real row — and the filed set is checked first, so
    //   this cannot overwrite it.
    const deniedHoliday = (ce.flags?.holiday_pay_denied
      && !nowCodes.has(`${RECORD_TYPE.SALARY}:${HOLIDAY_CODE}`)
      && !staleKeys.has(`${RECORD_TYPE.SALARY}:${HOLIDAY_CODE}`)
      && !standing.some((z) => key(z) === `${RECORD_TYPE.SALARY}:${HOLIDAY_CODE}`))
      ? [{ code: HOLIDAY_CODE, table: RECORD_TYPE.SALARY }] : [];

    for (const p of [...stale, ...standing, ...deniedHoliday]) {
      rows.push([label, empNo, p.table || RECORD_TYPE.SALARY, p.code, 0, 0]);
    }
    const all = [...stale, ...standing, ...deniedHoliday];
    if (all.length) {
      notes.push({
        employee_number: empNo, full_name: ce.employee.full_name,
        subject: 'רכיבים שבוטלו',
        text: `${all.length} רכיבים שאינם רלוונטיים החודש נשלחו עם 0 כדי לבטלם: קודים ${all.map((p) => p.code).join(', ')}.`
          + (standing.length ? ` (${standing.map((z) => z.code).join(', ')} — מרשימת הקודים לביטול קבוע)` : '')
          + (deniedHoliday.length ? ` (${HOLIDAY_CODE} — אינה זכאית לדמי חגים החודש, נשלח 0 כדי ששקלולית לא תגרור את הסכום מהחודש הקודם)` : ''),
      });
    }
  }

  return { header, rows, notes, filed };
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
