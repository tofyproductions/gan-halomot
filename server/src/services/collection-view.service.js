const { ACADEMIC_MONTHS, CAMP_MONTH } = require('./academic-year.service');
const { calculatePaymentStatus } = require('./prorate.service');

/**
 * What one child's year of payments comes to.
 *
 * Extracted from collections.controller so that the parent portal and the
 * staff table compute money the same way. They must: the figures on this
 * screen are not stored, they are DERIVED on every read — from prorating a
 * child who started in November, a fee that changed in March, the branch's
 * discounts, and a receipt one parent paid covering two siblings. A second
 * implementation of that would be a second answer to "what do I owe", and the
 * two would drift on the first discount nobody remembered to copy across.
 *
 * Deliberately pure. Every input is passed in — no models, no request, no
 * branch filter — because the staff table fetches for a whole branch at once
 * and the portal fetches for one child, and the arithmetic between them must
 * not care which.
 */

/**
 * The two calendar years a gan year spans. 'YYYY-YYYY' in, [start, end] out.
 */
function yearsOf(academicYear) {
  const [y1, y2] = String(academicYear).split('-').map(Number);
  return [y1, y2];
}

/**
 * The last day the child is charged for, when they left mid-year.
 *
 * September through December fall in the first calendar year, January through
 * August in the second — the month number alone does not say which, and using
 * the wrong one bills a family for a year they were not here.
 */
function exitDateOf(exitMonth, academicYear) {
  if (exitMonth == null) return null;
  const [y1, y2] = yearsOf(academicYear);
  const exitY = exitMonth >= 9 ? y1 : y2;
  const lastDay = new Date(exitY, exitMonth, 0).getDate();
  return new Date(exitY, exitMonth - 1, lastDay);
}

/**
 * What the discounts in scope take off one month's fee.
 *
 * Scope widens outward: a discount on this child, on their classroom, or on
 * the whole branch. `month` null means every month.
 */
function discountFor(discounts, regId, classroomId, monthNum, baseFee) {
  let total = 0;
  for (const d of discounts || []) {
    if (d.month && d.month !== monthNum) continue;
    if (d.scope === 'child' && String(d.registration_id) !== String(regId)) continue;
    if (d.scope === 'classroom' && String(d.classroom_id) !== String(classroomId)) continue;
    // scope === 'branch' matches everyone.
    total += d.discount_type === 'percentage' ? baseFee * (d.value / 100) : d.value;
  }
  return Math.round(total);
}

/**
 * A sibling's receipt for this month, marked as borrowed.
 *
 * One payment covers a household, and it is entered against whichever child
 * the office happened to open. The leading '-' is how the rest of the system
 * says "this receipt is not this child's own" — and it is why a receipt number
 * on a parent's screen may carry their other child's name.
 *
 * A borrowed receipt is never borrowed onward: only a sibling's OWN receipt
 * (no '-') is offered, or two children would point at each other forever.
 */
function siblingReceipt(siblings, monthNum) {
  for (const sib of siblings || []) {
    const month = sib.collection?.months?.find(m => m.month_number === monthNum);
    const num = month?.receipt_number;
    if (num && !String(num).startsWith('-')) return '-' + num;
  }
  return null;
}

/** The same, for the one-off registration fee. */
function siblingRegistrationFee(siblings) {
  for (const sib of siblings || []) {
    if (sib.collection?.registration_fee_receipt) {
      return '-' + sib.collection.registration_fee_receipt;
    }
  }
  return null;
}

/**
 * The קייטנה cell, or null when this branch runs no camp this year.
 *
 * Flat-rated, never prorated: the camp is a fixed-price product and not a
 * month of care. See models/SummerCamp.js and models/Collection.js —
 * `camp_enrolled` is three-state on purpose, and `null` (nobody has said)
 * charges the default while refusing to inherit a sibling's receipt.
 */
function buildCampCell({ camp, collection, existing, siblings }) {
  if (!camp) return null;

  const exitM = collection?.exit_month ?? null;
  // July and August are the camp's own months — leaving "at" them is not
  // leaving before it.
  const leftEarly = exitM != null && exitM !== 7 && exitM !== 8;
  const enrolled = collection?.camp_enrolled ?? null;

  const hasOverride = existing.fee_override != null;
  const base = camp.amount || 0;
  const expected = hasOverride
    ? existing.fee_override
    : (leftEarly || enrolled === false ? 0 : base);

  let receiptNumber = existing.receipt_number || null;
  if (!receiptNumber && enrolled === true) receiptNumber = siblingReceipt(siblings, CAMP_MONTH);

  let paymentStatus = existing.payment_status || 'expected';
  if (receiptNumber) paymentStatus = 'paid';
  else if (enrolled === false) paymentStatus = 'exempt';

  return {
    month: CAMP_MONTH,
    label: camp.label || 'קייטנה',
    camp_enrolled: enrolled,
    expected_amount: expected,
    paid_amount: paymentStatus === 'paid' ? expected : (parseFloat(existing.paid_amount) || 0),
    discount_amount: 0,
    receipt_number: receiptNumber,
    payment_status: paymentStatus,
    payment_date: existing.payment_date || null,
    is_prorated: false,
    is_before_start: false,
    left_early: !!leftEarly,
    notes: existing.notes || null,
    has_fee_override: hasOverride,
    fee_override_reason: existing.fee_override_reason || null,
    original_expected: hasOverride ? (leftEarly ? 0 : base) : null,
  };
}

/**
 * One registration's twelve months, plus the camp when there is one.
 *
 * Returns the full staff-facing shape — internal notes and override reasons
 * included. Anything shown to a parent must be filtered on the way out; see
 * controllers/parentPayments.controller.js, which lists the fields it passes
 * on one by one rather than spreading this object.
 */
function buildRegistrationMonths({
  reg,
  academicYear,
  collection = null,
  discounts = [],
  camp = null,
  siblings = [],
}) {
  const monthsMap = {};
  for (const m of (collection?.months || [])) monthsMap[m.month_number] = m;

  const fee = parseFloat(reg.monthly_fee) || 0;
  const classroomObjId = reg.classroom_id?._id || reg.classroom_id;
  const endDate = exitDateOf(collection?.exit_month ?? null, academicYear);

  // A fee that changed mid-year: charge the old one up to the month it
  // changed, the new one from there on. `fee_effective_from` is 'YYYY-MM'.
  let priceChangeMonth = null;
  let oldFee = null;
  if (reg.fee_effective_from && reg.previous_monthly_fee != null) {
    const [, effMonth] = reg.fee_effective_from.split('-').map(Number);
    if (effMonth >= 1 && effMonth <= 12) {
      priceChangeMonth = effMonth;
      oldFee = reg.previous_monthly_fee;
    }
  }

  const { expectedFees, isBeforeStart } = calculatePaymentStatus(
    oldFee != null ? oldFee : fee,
    reg.start_date,
    academicYear,
    endDate ? endDate.toISOString().split('T')[0] : reg.end_date,
    priceChangeMonth,
    priceChangeMonth ? fee : undefined,
  );

  const months = ACADEMIC_MONTHS.map((m) => {
    const existing = monthsMap[m] || {};
    let expected = expectedFees[m] || 0;

    const discount = expected > 0 ? discountFor(discounts, reg._id, classroomObjId, m, expected) : 0;
    expected = Math.max(0, expected - discount);

    const hasFeeOverride = existing.fee_override != null;
    const originalExpected = hasFeeOverride ? expected : null;
    if (hasFeeOverride) expected = existing.fee_override;

    const receiptNumber = existing.receipt_number || null;
    // A receipt is the payment. Once one exists the month is paid, whatever
    // the stored status says — and a borrowed sibling receipt counts.
    const paymentStatus = receiptNumber
      ? 'paid'
      : (existing.payment_status || (isBeforeStart[m] ? 'pending' : 'expected'));

    const paid = paymentStatus === 'paid' ? expected : (parseFloat(existing.paid_amount) || 0);

    return {
      month: m,
      expected_amount: expected,
      paid_amount: paid,
      discount_amount: discount,
      receipt_number: receiptNumber,
      payment_status: paymentStatus,
      payment_date: existing.payment_date || null,
      is_prorated: existing.is_prorated || false,
      is_before_start: isBeforeStart[m] || false,
      notes: existing.notes || null,
      has_fee_override: hasFeeOverride,
      fee_override_reason: existing.fee_override_reason || null,
      original_expected: originalExpected,
    };
  });

  const campCell = buildCampCell({
    camp,
    collection,
    existing: monthsMap[CAMP_MONTH] || {},
    siblings,
  });

  return {
    months,
    campCell,
    registration_fee_receipt:
      collection?.registration_fee_receipt || siblingRegistrationFee(siblings),
  };
}

module.exports = {
  buildRegistrationMonths,
  exitDateOf,
  discountFor,
  siblingReceipt,
  siblingRegistrationFee,
  yearsOf,
};
