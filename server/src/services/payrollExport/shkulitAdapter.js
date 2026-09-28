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
const COMPONENTS = [
  { key: 'salary_completion', code: 38, label: 'השלמת שכר', get: (ce) => ce.earnings.salary_completion },
  { key: 'travel', code: 3, label: 'נסיעות', get: (ce) => ce.earnings.travel },
  { key: 'holiday_pay', code: 44, label: 'ימי חג', unit: 'ימים', get: (ce) => ce.earnings.holiday_pay, units: (ce) => ce.quantities.holiday_days },
  { key: 'sick_pay', code: 34, label: 'ימי מחלה', unit: 'ימים', get: (ce) => ce.earnings.sick_pay, units: (ce) => ce.quantities.sick_days },
  { key: 'bonus', code: 35, label: 'בונוס', get: (ce) => ce.earnings.bonus },
  { key: 'august_bonus', code: 39, label: 'בונוס מיוחד (מענק אוגוסט)', get: (ce) => ce.earnings.august_bonus },
  { key: 'miluim', code: 42, label: 'ימי מילואים', get: (ce) => ce.earnings.miluim },
  { key: 'absence', code: 36, label: 'ימים חסרים', sign: -1, unit: 'ימים', get: (ce) => ce.deductions.absence, units: (ce) => ce.quantities.absence_deduct_days },
  { key: 'partial_absence', code: 41, label: 'שעות חסרות', sign: -1, unit: 'שעות', get: (ce) => ce.deductions.partial_absence, units: (ce) => ce.quantities.partial_absence_hours },
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
  { key: 'meal_vouchers', label: 'תווי מזון / כלכלה', table: RECORD_TYPE.IMPUTED, hint: 'זקופות — שווי ארוחות (קוד 2 או 21)', get: (ce) => ce.earnings.meal_vouchers },
  { key: 'cibus', label: 'סיבוס', table: RECORD_TYPE.IMPUTED, hint: 'זקופות — שווי ארוחות (קוד 2 או 21)', get: (ce) => ce.earnings.cibus },
  { key: 'gift_card', label: 'תו קנייה (גיפט קארד)', table: RECORD_TYPE.IMPUTED, hint: 'זקופה — לוודא קוד', get: (ce) => ce.earnings.gift_card },
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
function buildMovements(source, previousByEmployee = new Map(), componentCodes = {}) {
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
    } else if (ce.earnings.teken_regular || ce.earnings.teken_ot125 || ce.earnings.teken_ot150) {
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

    // ימי חופשה — the days FILED, which is not always the days taken.
    //
    // Paid leave is drawn from a balance: seven days away against a balance of
    // two is two days filed, because the other five have not been earned and
    // filing them would pay leave she does not hold. The capping happens in the
    // source layer so this file and the accountant's cards cannot disagree; all
    // that is decided here is how the number travels.
    //
    // It travels as a NOTE rather than a row because ימי חופשה has no confirmed
    // קוד רכיב — the checklist still lists it as an open question ("7/8/לא
    // בקובץ?"). Guessing one is what cost the 28.09 import, so the count and its
    // reason go where the accountant reads them and she keys the line herself.
    // The day the code is confirmed this becomes a row and nothing else changes.
    const vacDays = round2(Number(ce.quantities?.vacation_days) || 0);
    const vacTaken = round2(Number(ce.quantities?.vacation_days_taken) || 0);
    if (vacDays > 0 || vacTaken > 0) {
      notes.push({
        employee_number: empNo, full_name: ce.employee.full_name,
        subject: 'ימי חופשה',
        text: ce.quantities?.vacation_capped
          ? `לתשלום: ${vacDays} ימים — מוגבל ליתרה. בפועל נעדרה ${vacTaken} ימים, והיתרה בתחילת החודש הייתה ${round2(Number(ce.quantities.vacation_balance_available) || 0)}. ${round2(ce.quantities.vacation_days_unpaid)} ימים נותרו ללא תשלום עד להחלטת המשרד.`
          : `${vacDays} ימי חופשה.`,
      });
    }

    // ימי עבודה — the count, and it does NOT go in the file.
    //
    // It was briefly filed under code 4, on the understanding that 4 was the
    // work-days code for a global employee. Code 4 is הבראה. Both our own
    // אקסולוגיה table and שקלולית's screen say so, and the row our file
    // produced showed up in the payslip as a הבראה line. It paid nothing only
    // because the rate went out as 0 — put a rate on that row and it pays
    // recreation money to every global employee in the gan, in the wrong month.
    //
    // That is the guessed-code failure the 28.09 import already cost us once,
    // and it is the reason nothing enters this file on a verbal code alone. The
    // count travels as a note for everybody until someone confirms the real
    // code with the software house.
    const daysWorked = round2(Number(ce.quantities?.days_worked) || 0);
    if (daysWorked > 0) {
      notes.push({
        employee_number: empNo, full_name: ce.employee.full_name,
        subject: 'ימי עבודה',
        text: `${daysWorked} ימי עבודה בחודש. הקוד לדיווח ימי עבודה טרם אושר (קוד 4 שייך להבראה), ולכן הכמות נמסרת כאן ולא כשורה בקובץ.`,
      });
    }

    // Components whose קוד רכיב nobody has confirmed.
    //
    // Once a code IS confirmed it is entered in the settings screen, and from
    // that moment the component becomes a real row instead of a line the
    // accountant re-keys by hand. Nothing is guessed: with no code configured
    // the component still travels as a note, exactly as before.
    //
    // This is the whole difference between "we don't know the code" and "we
    // can't send it" — the second was never true, it was just how the first
    // was implemented.
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

  // ── switching off last month's leftovers ────────────────────────────────
  //
  // שקלולית carries a payslip forward: a component that was filed last month
  // and is missing this month is not dropped, it is PAID AGAIN at last month's
  // value. That is how הבראה — paid once a year, in August — turns up in
  // September, and how last month's 150% overtime keeps paying an employee who
  // worked none.
  //
  // So every code we filed before and are not filing now goes out again at
  // zero, which is what switches it off. The alternative is the accountant
  // reading seventy previous payslips line by line every month, which is
  // exactly the kind of task that works until the one month it doesn't.
  //
  // Only codes WE filed can be switched off this way — see the note in
  // models/ShkulitMovementSnapshot.js. What the accountant keys by hand is
  // listed for her below instead of being silently overwritten.
  for (const ce of source.ready) {
    const empNo = ce.employee.employee_number;
    const nowFiled = filed.get(empNo) || [];
    const nowCodes = new Set(nowFiled.map((c) => `${c.table}:${c.code}`));
    const previous = previousByEmployee.get(String(empNo)) || [];
    const stale = previous.filter((p) => !nowCodes.has(`${p.table || RECORD_TYPE.SALARY}:${p.code}`));
    for (const p of stale) {
      rows.push([label, empNo, p.table || RECORD_TYPE.SALARY, p.code, 0, 0]);
    }
    if (stale.length) {
      notes.push({
        employee_number: empNo, full_name: ce.employee.full_name,
        subject: 'רכיבים שבוטלו',
        text: `${stale.length} רכיבים שהופיעו בקובץ הקודם ואינם רלוונטיים החודש נשלחו עם 0 כדי לבטלם: קודים ${stale.map((p) => p.code).join(', ')}.`,
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
