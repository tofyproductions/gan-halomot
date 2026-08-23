/**
 * תנאי העסקה with a date on them.
 *
 * THE BUG THIS CLOSES. A month's salary is recomputed from the employee card
 * every time somebody opens the screen — PayrollMonth caches the result but
 * says so plainly: only a finalized month stops recomputing. The card carries
 * one rate and no date, so raising 52₪ to 60₪ raised January too, and
 * February, and every other month nobody had finalized yet. The screen showed
 * the new number as though it had always been the number.
 *
 * A rate needs a date before a raise can be recorded at all. That is all this
 * file is: a dated row per change, a resolver that answers "what were the
 * terms in THIS month", and one writer that keeps the row and the card in
 * agreement.
 *
 * THE MONTH IS THE UNIT. The accountant picks a real day, because that is what
 * the signed contract says, and it is stored. But payroll reads the month:
 * the calculator sums a month of hours and multiplies once, so a rate that
 * changes on the 15th would mean splitting the month's hours at a boundary the
 * calculator has no concept of. A date inside a month therefore pays that
 * whole month at the new terms, and the UI says so before anyone saves.
 *
 * THE BASELINE. The first change on an employee writes TWO rows: the old terms
 * dated from before any payroll exists, then the new ones. Skipping the
 * baseline would leave every earlier month with no row to find, falling back
 * to the card — which by then holds the new rate. That fallback is the
 * original bug wearing the new feature's clothes.
 */

const IL_TZ = 'Asia/Jerusalem';

/** 'YYYY-MM' for a date, in Israel local time (a UTC month can be the wrong one). */
function monthOf(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: IL_TZ }).format(new Date(date)).slice(0, 7);
}

/** Earlier than any payroll this system has ever produced. */
const BASELINE_MONTH = '1900-01';

/**
 * The terms in force during `monthYM`, or null when nothing is recorded and
 * the caller should read the card as it always did.
 *
 * Picks the latest row that had already started by that month. Rows dated in
 * the FUTURE are deliberately invisible here: an accountant may record a raise
 * that starts in October, and September must keep paying September's rate.
 */
function termsForMonth(employee, monthYM) {
  const rows = Array.isArray(employee?.terms_history) ? employee.terms_history : [];
  if (!rows.length || !monthYM) return null;

  let best = null;
  for (const r of rows) {
    if (!r?.effective_month || r.effective_month > monthYM) continue;
    // Same month recorded twice → the one entered later wins, which is what
    // "I got it wrong, here it is again" should do.
    if (!best
      || r.effective_month > best.effective_month
      || (r.effective_month === best.effective_month
          && new Date(r.created_at || 0) >= new Date(best.created_at || 0))) {
      best = r;
    }
  }
  if (!best) return null;

  return {
    salary_type: best.salary_type || 'hourly',
    hourly_rate: best.hourly_rate,
    global_salary: best.global_salary,
    global_ot_rate: best.global_ot_rate,
    required_hours: best.required_hours,
    effective_month: best.effective_month,
    effective_date: best.effective_date || null,
    source: best.source || 'manual',
  };
}

/** The terms currently on the card, in the shape a history row uses. */
function termsFromCard(employee) {
  const dist = Array.isArray(employee?.amuta_distribution) ? employee.amuta_distribution : [];
  const first = dist.find((d) => d.hourly_rate || d.global_salary) || dist[0] || {};
  return {
    salary_type: employee?.salary_type === 'global' ? 'global' : 'hourly',
    hourly_rate: first.hourly_rate ?? null,
    global_salary: first.global_salary ?? null,
    global_ot_rate: first.global_ot_rate ?? null,
    required_hours: first.required_hours ?? null,
  };
}

const num = (v) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Validate a requested change and describe what it would do — without writing
 * anything. The dialog calls this to show the accountant the before/after and
 * the warning about already-closed months; `applyTermsChange` calls it so the
 * two can never disagree about what "valid" means.
 */
function planTermsChange(employee, input = {}) {
  const errors = [];

  const when = input.effective_date ? new Date(input.effective_date) : null;
  if (!when || Number.isNaN(when.getTime())) errors.push('יש לבחור תאריך תחילת תוקף');

  const salaryType = input.salary_type === 'global' ? 'global' : 'hourly';
  const next = {
    salary_type: salaryType,
    hourly_rate: salaryType === 'hourly' ? num(input.hourly_rate) : null,
    global_salary: salaryType === 'global' ? num(input.global_salary) : null,
    global_ot_rate: salaryType === 'global' ? num(input.global_ot_rate) : null,
    required_hours: salaryType === 'global' ? num(input.required_hours) : null,
  };

  if (salaryType === 'hourly') {
    if (!next.hourly_rate || next.hourly_rate <= 0) errors.push('יש להזין שכר שעתי');
  } else {
    if (!next.global_salary || next.global_salary <= 0) errors.push('יש להזין שכר חודשי');
    if (!next.required_hours || next.required_hours <= 0) errors.push('יש להזין שעות חודשיות');
  }

  if (errors.length) return { errors };

  const effective_month = monthOf(when);
  const previous = termsForMonth(employee, effective_month) || termsFromCard(employee);
  const nothingChanged = ['salary_type', 'hourly_rate', 'global_salary', 'global_ot_rate', 'required_hours']
    .every((k) => (previous[k] ?? null) === (next[k] ?? null));

  return {
    errors: [],
    effective_month,
    effective_date: when,
    previous,
    next,
    nothingChanged,
    // True when the date lands mid-month — the UI says the whole month moves.
    mid_month: when.getDate() !== 1,
    needs_baseline: !(employee.terms_history || []).length,
  };
}

/**
 * Mutate `employee` (a mongoose document) to record the change and bring the
 * card into line. Does NOT save — the caller decides that, so the contract and
 * the terms land together or not at all.
 *
 * The card always ends up holding the NEWEST terms, even ones dated in the
 * future. The card is what documents and screens read; payroll reads the dated
 * rows, and those keep the closed months honest regardless.
 */
function applyTermsChange(employee, input, actor = {}) {
  const plan = planTermsChange(employee, input);
  if (plan.errors.length) return plan;

  if (!Array.isArray(employee.terms_history)) employee.terms_history = [];

  if (plan.needs_baseline) {
    employee.terms_history.push({
      ...termsFromCard(employee),
      effective_month: BASELINE_MONTH,
      effective_date: employee.start_date || null,
      source: 'baseline',
      note: 'התנאים שהיו רשומים בכרטיס לפני השינוי הראשון שנרשם',
      created_by: actor.id || null,
      created_by_name: actor.full_name || '',
      created_at: new Date(),
    });
  }

  employee.terms_history.push({
    ...plan.next,
    effective_month: plan.effective_month,
    effective_date: plan.effective_date,
    source: input.contract_id ? 'contract' : 'manual',
    contract_id: input.contract_id || null,
    note: String(input.note || '').trim(),
    created_by: actor.id || null,
    created_by_name: actor.full_name || '',
    created_at: new Date(),
  });

  // --- bring the card into line -----------------------------------------
  // The rate lives on the first amuta split. An employee with no split at all
  // has nowhere to put it; that is a card that was never set up, and the
  // caller is told rather than having a split invented for them.
  employee.salary_type = plan.next.salary_type;
  const dist = Array.isArray(employee.amuta_distribution) ? employee.amuta_distribution : [];
  const idx = dist.findIndex((d) => d.hourly_rate || d.global_salary);
  const target = idx >= 0 ? idx : (dist.length ? 0 : -1);
  if (target < 0) {
    return { ...plan, errors: ['לעובד/ת אין עמותה משויכת בכרטיס — יש להגדיר אותה לפני עדכון תנאים'] };
  }
  dist[target].hourly_rate = plan.next.hourly_rate;
  dist[target].global_salary = plan.next.global_salary;
  dist[target].global_ot_rate = plan.next.global_ot_rate;
  dist[target].required_hours = plan.next.required_hours;
  employee.markModified?.('amuta_distribution');
  employee.markModified?.('terms_history');

  return plan;
}

module.exports = {
  monthOf,
  termsForMonth,
  termsFromCard,
  planTermsChange,
  applyTermsChange,
  BASELINE_MONTH,
};
