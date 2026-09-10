const { Registration, Collection, Discount, SummerCamp, Branch, ExternalEnrollment } = require('../models');
const {
  normalizeYear, formatAcademicYear, hebrewYearForStart, enrollmentYear,
  HEBREW_MONTHS, CAMP_MONTH,
} = require('../services/academic-year.service');
const { buildRegistrationMonths } = require('../services/collection-view.service');
const { buildHouseholds } = require('../services/household.service');
const { loadOwnChild } = require('./parentPortal.controller');

/**
 * What the family owes, as the family may see it.
 *
 * Read-only, on purpose and permanently as far as this file is concerned:
 * there is no route here that moves money, takes a card, or marks anything
 * paid. A parent looks and downloads a receipt; everything else is the
 * office's.
 *
 * The figures are NOT recomputed here. services/collection-view is the one
 * implementation, shared with the staff table — the alternative was a second
 * arithmetic for the same money, and the first discount somebody added to one
 * and not the other would have put a different number on the parent's screen
 * than on the bookkeeper's.
 *
 * What this file does own is the filter on the way out. The staff shape
 * carries `notes` and `fee_override_reason`, which are the office writing to
 * itself — "המשפחה בקשיים", "דחינו לה חודש" — and every field below is listed
 * one at a time rather than spread, so nothing new reaches a parent by simply
 * being added upstream.
 */

/** 'ספטמבר' for 9. HEBREW_MONTHS is January-first. */
function monthName(n) {
  return n === CAMP_MONTH ? 'קייטנה' : (HEBREW_MONTHS[n - 1] || String(n));
}

/**
 * The academic month the gan is in right now, or null outside the year.
 *
 * The point of this is the one month a parent actually came to look at. It is
 * derived from the clock rather than from a status, because "the current
 * month" is not something anybody remembers to update.
 */
function currentAcademicMonth(academicYear) {
  const [y1, y2] = String(academicYear).split('-').map(Number);
  const now = new Date();
  const m = now.getMonth() + 1;
  const y = now.getFullYear();
  if (y === y1 && m >= 9) return m;
  if (y === y2 && m <= 8) return m;
  return null;
}

/**
 * A receipt, and whether it is this child's own.
 *
 * A leading '-' is how the rest of the system marks a receipt inherited from a
 * sibling: one payment, one document, two children. The parent gets the real
 * number and a flag — without the flag they are looking at their daughter's
 * screen showing a receipt issued in their son's name, which reads as a fault.
 */
function receiptOf(raw) {
  if (!raw) return { receipt: null, shared_with_sibling: false };
  const s = String(raw);
  return s.startsWith('-')
    ? { receipt: s.slice(1), shared_with_sibling: true }
    : { receipt: s, shared_with_sibling: false };
}

/**
 * Is this child's fee still unknown?
 *
 * At the subsidised branches the monthly fee follows the family's income
 * bracket, which arrives separately and later; placement enrols the child at
 * zero and flags the registration rather than holding them out of the gan
 * (see controllers/externalEnrollment). Zero is also what a fee of zero looks
 * like, and the difference is the whole reason the flag exists.
 *
 * Both conditions, not just the flag. Nothing ever clears `fee_pending` once
 * it is set, so on the flag alone a family whose bracket came through in
 * October would never see this screen again. A real fee on the registration
 * is the office having answered the question.
 */
function feeStillUnknown(reg) {
  const flagged = reg?.configuration?.external_source?.fee_pending === true;
  const fee = parseFloat(reg?.monthly_fee) || 0;
  return flagged && fee <= 0;
}

/**
 * The previous academic year. '2026-2027' → '2025-2026'.
 *
 * A debt does not end because a year did, and the ClickTac file that carries
 * last year's balance is uploaded separately from this year's.
 */
function previousYear(academicYear) {
  const [y1, y2] = String(academicYear).split('-').map(Number);
  return `${y1 - 1}-${y2 - 1}`;
}

/**
 * What the family owes at a branch WE DO NOT COLLECT FOR.
 *
 * The gan's money is split down the middle and always has been. קפלן registers
 * its families directly with us and the office enters every receipt here, so
 * those parents get the month-by-month table above — expected, paid, receipt
 * number, the lot. Every other branch is under משרד התמ"ת: the family enrols
 * through קליקטאק, pays through קליקטאק, and this system never sees a single
 * payment. Until now that meant those parents were shown nothing at all — the
 * section was not even offered to them — while their neighbours at קפלן had a
 * full ledger.
 *
 * What we DO hold for them is one number: the מאזן from the last contracts
 * export somebody uploaded, the same figure the office reads in the חייבים
 * table. So that is what this returns, and it is scrupulous about what it is:
 *
 *  - The date of the file it came from is shown beside it, always. A balance
 *    with no date is a claim about right now, and this one is a claim about
 *    whenever the last export was taken.
 *  - It says out loud that the figure is not live. A family who paid this
 *    morning must not read a month-old debt as the gan disputing it.
 *  - Every child of the family is on the one screen, each with their own line.
 *    ClickTac keeps an account per child; a parent of three wants the three,
 *    and wants them apart rather than summed into a number no document shows.
 *  - A child with no row is said to have no row. Not zero — a branch that has
 *    not uploaded a file this year owes nobody an invented balance.
 *
 * Nothing here is billed, chased or paid. It is the office's own figure, shown
 * to the family it is about.
 */
async function externalPayments(own, branch) {
  const { normalizeId } = require('../services/tmt.service');

  const currentYear = normalizeYear(enrollmentYear());
  const years = [currentYear, previousYear(currentYear)];

  // Every child of this parent, not only the one whose screen this is.
  const kids = (own.parent.groups || [])
    .map(g => g.current)
    .filter(Boolean);

  const idOf = (c) => normalizeId(c.child_id_number || '');
  const ids = [...new Set(kids.map(idOf).filter(Boolean))];

  // Matched on ת"ז rather than on this child's branch: siblings are not always
  // in the same gan, and a family with one child at משה דיין and another at
  // רעננה would otherwise be told the second has no account. Both spellings are
  // asked for — the file writes the number as it finds it, and normalizeId pads
  // to nine.
  const idVariants = [...new Set(ids.flatMap(id => [id, id.replace(/^0+/, '')]))];

  const rows = idVariants.length
    ? await ExternalEnrollment.find({
      academic_year: { $in: years },
      'child.id_number': { $in: idVariants },
    }).select('academic_year child.id_number contract.balance contract.family_balance contract.imported_at').lean()
    : [];

  // Newest file wins where a child appears twice — a family that moved branch
  // mid-year has a row on each side, and the older one is not their balance.
  const byChildYear = new Map();
  for (const r of rows) {
    const key = `${normalizeId(r.child?.id_number)}|${r.academic_year}`;
    const kept = byChildYear.get(key);
    const at = (x) => new Date(x?.contract?.imported_at || 0).getTime();
    if (!kept || at(r) >= at(kept)) byChildYear.set(key, r);
  }

  // The newest file any of these rows came from — the one date the whole
  // screen is "correct as of".
  let updatedAt = null;
  for (const r of rows) {
    const at = r.contract?.imported_at ? new Date(r.contract.imported_at) : null;
    if (at && !Number.isNaN(at.getTime()) && (!updatedAt || at > updatedAt)) updatedAt = at;
  }

  const children = kids.map((c) => {
    const id = idOf(c);
    const lines = years
      .map((year) => {
        const row = id ? byChildYear.get(`${id}|${year}`) : null;
        const balance = row?.contract?.balance;
        if (typeof balance !== 'number') return null;
        return {
          academic_year: year,
          year_label: formatAcademicYear(year),
          is_current_year: year === currentYear,
          // ClickTac stores a debt as a NEGATIVE balance. Flipped once, here,
          // so no screen has to remember the sign — and a credit stays a
          // credit rather than being shown as a debt of minus something.
          debt: balance < 0 ? Math.round(-balance) : 0,
          credit: balance > 0 ? Math.round(balance) : 0,
          updated_at: row.contract?.imported_at || null,
        };
      })
      .filter(Boolean);

    return {
      id: c._id,
      name: c.child_name,
      // No row at all is its own answer, and it is not "no debt".
      has_data: lines.length > 0,
      years: lines,
      debt: lines.reduce((s, l) => s + l.debt, 0),
    };
  });

  return {
    available: true,
    mode: 'external',
    branch_name: branch.name || '',
    updated_at: updatedAt,
    children,
    total_debt: children.reduce((s, c) => s + c.debt, 0),
  };
}

/**
 * GET /api/parent/children/:childId/payments
 */
async function childPayments(req, res) {
  const own = await loadOwnChild(req);
  if (!own) return res.status(404).json({ error: 'לא נמצא' });

  const { child } = own;

  // The populate on the child only carries the parent's contact fields, so
  // the registration is read again in full — the fee, the dates and the
  // pending flag all live on it.
  const regId = child.registration_id?._id || child.registration_id;
  const reg = regId ? await Registration.findById(regId).lean() : null;
  if (!reg) return res.status(404).json({ error: 'לא נמצא' });

  // Which half of the gan this family is in. Under the ministry, the money is
  // ClickTac's and all we hold is the balance from its last export; at קפלן
  // the office keeps the ledger here and the month-by-month table below is the
  // real thing. Decided by the BRANCH rather than by whether a fee happens to
  // be filled in — a supervised branch with a fee typed into it is still a
  // branch we do not collect for, and showing it a table of receipts we never
  // issued would invent a ledger.
  const { isTmtSupervised } = require('./tmtApproval.controller');
  const branch = reg.branch_id
    ? await Branch.findById(reg.branch_id).select('name tmt_supervised').lean()
    : null;
  if (branch && isTmtSupervised(branch)) {
    return res.json(await externalPayments(own, branch));
  }

  const academicYear = normalizeYear(child.academic_year || reg.academic_year || '');
  if (!academicYear) {
    return res.json({ available: false, reason: 'no_year' });
  }

  // A fee nobody has set yet is not a fee of zero, and "0 ₪ לתשלום" on a
  // parent's screen is a promise the gan will have to break in November.
  if (feeStillUnknown(reg)) {
    return res.json({ available: false, reason: 'fee_pending' });
  }

  const [collection, discounts, camp, identities] = await Promise.all([
    Collection.findOne({ registration_id: reg._id, academic_year: academicYear }).lean(),
    Discount.find({ is_active: true, branch_id: reg.branch_id }).lean(),
    reg.branch_id
      ? SummerCamp.findOne({ branch_id: reg.branch_id, academic_year: academicYear, enabled: true }).lean()
      : null,
    // Every registration in the system, five fields wide.
    //
    // NOT a filter on this parent's ID number. Two parents of one family sign
    // different children, so a query on the father's number never reaches the
    // sibling the mother registered — and that sibling is exactly where a
    // shared receipt lives. buildHouseholds finds the join through the
    // children themselves, and it can only do that with the whole set in
    // front of it. Five fields, no populate: a cheap read, and the staff
    // collections screen already loads the same on every page view.
    Registration.find({})
      .select('parent_id_number parent_name parent_phone child_name child_birth_date')
      .lean(),
  ]);

  const householdOf = buildHouseholds(identities);
  const myHousehold = householdOf(reg);
  const siblingIds = myHousehold
    ? identities
        .filter(r => String(r._id) !== String(reg._id) && householdOf(r) === myHousehold)
        .map(r => r._id)
    : [];

  // Only the sibling's collection for THIS year, and nothing else about them.
  // Their fee, their dates and their notes are their registration's business,
  // not something to load into this parent's request.
  const siblings = siblingIds.length
    ? (await Collection.find({
        registration_id: { $in: siblingIds },
        academic_year: academicYear,
      }).lean()).map(c => ({ reg: { _id: c.registration_id }, collection: c }))
    : [];

  const built = buildRegistrationMonths({
    reg,
    academicYear,
    collection: collection || null,
    discounts,
    camp: camp || null,
    siblings,
  });

  const current = currentAcademicMonth(academicYear);

  const months = built.months.map((m) => ({
    month: m.month,
    label: monthName(m.month),
    expected: m.expected_amount,
    paid: m.paid_amount,
    discount: m.discount_amount,
    status: m.payment_status,
    paid_at: m.payment_date,
    is_prorated: m.is_prorated,
    // Before the child started. Shown as "לא רלוונטי" rather than as a debt
    // of zero, which looks like a month somebody forgot to bill.
    is_before_start: m.is_before_start,
    is_current: m.month === current,
    ...receiptOf(m.receipt_number),
  }));

  const campCell = built.campCell && {
    month: CAMP_MONTH,
    label: built.campCell.label || 'קייטנה',
    expected: built.campCell.expected_amount,
    paid: built.campCell.paid_amount,
    discount: 0,
    status: built.campCell.payment_status,
    paid_at: built.campCell.payment_date,
    enrolled: built.campCell.camp_enrolled,
    is_prorated: false,
    is_before_start: false,
    is_current: false,
    ...receiptOf(built.campCell.receipt_number),
  };

  const billable = [...months, ...(campCell ? [campCell] : [])]
    .filter(m => !m.is_before_start && m.expected > 0);
  const expected = billable.reduce((sum, m) => sum + m.expected, 0);
  const paid = billable.reduce((sum, m) => sum + m.paid, 0);

  const regFee = receiptOf(built.registration_fee_receipt);

  return res.json({
    available: true,
    academic_year: academicYear,
    year_label: formatAcademicYear(academicYear),
    year_short: hebrewYearForStart(Number(academicYear.split('-')[0])),
    current_month: current,
    summary: {
      expected,
      paid,
      // Never below zero. An overpayment is a conversation with the office,
      // not a negative number on a phone.
      remaining: Math.max(0, expected - paid),
      months_paid: billable.filter(m => m.status === 'paid').length,
      months_billable: billable.length,
    },
    months,
    camp: campCell,
    registration_fee: reg.registration_fee
      ? { amount: reg.registration_fee, ...regFee }
      : null,
    // True when any receipt on this screen was issued against a sibling. The
    // screen uses it to explain itself once, at the bottom, rather than
    // repeating the note on every row.
    has_shared_receipts:
      months.some(m => m.shared_with_sibling) ||
      !!campCell?.shared_with_sibling ||
      regFee.shared_with_sibling,
  });
}

module.exports = { childPayments };
