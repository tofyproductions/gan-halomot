/**
 * Kaplan income engine — which family a parent's bank transfer came from,
 * and which children's months it pays. Spec §1 (2026-10-01-income-design).
 *
 * Everything here is computed on read; nothing writes. In particular the
 * collections table is never touched: it is fed by the Sheets sync and the
 * office's receipts, and a bank allocation lives in IncomeAllocation beside
 * it (spec "הכרעה מרכזית").
 *
 * Shape follows the expense pair engine (expensePairs.service): a pool of
 * open bank lines, a score per (line, candidate), and a greedy global
 * assignment — except a family is not used once: it takes as many transfers
 * as it has open months to pay.
 */
const mongoose = require('mongoose');
const {
  BankAccount, BankTransaction, Branch, Registration, Child, Collection, Discount, SummerCamp,
  IncomeAllocation, IncomeRejection, IncomePayerAlias,
} = require('../models');
const incomeRules = require('./incomeRules.service');
const { getStartDate, vendorKey, COVERAGE_TOLERANCE_ILS } = require('./expenseCore.service');
const { nameOverlap } = require('./expensePairs.service');
const { buildHouseholds } = require('./household.service');
const { buildRegistrationMonths } = require('./collection-view.service');
const { academicYearOf, ACADEMIC_MONTHS, CAMP_MONTH } = require('./academic-year.service');

// Scoring constants — owner's ruling (constraints.md), binding.
const SUGGEST_THRESHOLD = 55;
const AMOUNT_TOLERANCE_ILS = 2;
const ALTERNATIVES_LIMIT = 5;

const WHY_NONE = 'לא נמצאה משפחה מתאימה';
const WHY_TIE = 'כמה משפחות באותו ציון — בחרו ידנית';
const WHY_NO_YEAR = 'אין משפחות קפלן בשנת הלימודים של ההעברה';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const key = (x) => String(x._id);
const rejKey = (txId, householdKey) => `${txId}|${householdKey}`;
/** Academic order of a month number, the camp after August. */
const monthOrder = (m) => (m === CAMP_MONTH ? 12 : ACADEMIC_MONTHS.indexOf(m));

/**
 * The gan year a transfer belongs to, by calendar month alone: September to
 * December open the year, January to August close it. Deliberately no
 * 10-August cutoff (getAcademicYearStr has one, for registrations) — money
 * paid in late August is for the year that is ending.
 */
function academicYearOfDate(ymd) {
  const m = /^(\d{4})-(\d{2})/.exec(String(ymd || ''));
  if (!m) return null;
  const y = Number(m[1]);
  const month = Number(m[2]);
  const start = month >= 9 ? y : y - 1;
  return `${start}-${start + 1}`;
}

/** The text the bank shows for who paid — what a payer alias is keyed on. */
function payerKey(tx) {
  return vendorKey(tx?.counterparty || tx?.description || '');
}

/** The bank line's name text: description + payee (spec §1, scoring). */
const txText = (tx) => [tx.description, tx.counterparty].filter(Boolean).join(' ');

/** What is left of the transfer to give. */
const remainingOf = (tx) => (tx.remaining != null ? Number(tx.remaining) : Number(tx.amount) || 0);

// ── pool ────────────────────────────────────────────────────────────────────

/**
 * Incoming bank lines not yet fully allocated: money in, a bank (not card)
 * account, not an internal transfer, from the expenses start date. A line an
 * active income rule catches (the Emunah transfer, interest, refunds) is
 * returned in `exempt` with its rule — never dropped.
 */
async function incomePool() {
  const start = await getStartDate();
  const bankIds = (await BankAccount.find({ type: 'bank' }, '_id').lean()).map(a => a._id);
  if (!bankIds.length) return { open: [], exempt: [] };
  const txs = await BankTransaction.find({
    account_id: { $in: bankIds },
    date: { $gte: start },
    amount: { $gt: 0 },
    is_internal_transfer: { $ne: true },
    status: 'completed',
  }).sort({ date: 1, _id: 1 }).lean();
  if (!txs.length) return { open: [], exempt: [] };

  const allocated = new Map();
  const sums = await IncomeAllocation.aggregate([
    { $match: { transaction_id: { $in: txs.map(t => t._id) } } },
    { $group: { _id: '$transaction_id', total: { $sum: '$amount' } } },
  ]);
  for (const s of sums) allocated.set(String(s._id), s.total);

  const rules = await incomeRules.activeRules();
  const open = [];
  const exempt = [];
  for (const t of txs) {
    const remaining = round2(t.amount - (allocated.get(key(t)) || 0));
    if (remaining <= COVERAGE_TOLERANCE_ILS) continue;
    const out = { ...t, remaining };
    // The Emunah transfer is often named only in the payee, so the payee counts.
    const rule = incomeRules.match([t.description, t.original_description, t.counterparty].filter(Boolean).join(' '), rules);
    if (rule) {
      exempt.push({ tx: out, rule: { _id: rule._id, label: rule.label, pattern: rule.pattern, note: rule.note || '', built_in: !!rule.built_in } });
    } else open.push(out);
  }
  return { open, exempt };
}

// ── households ──────────────────────────────────────────────────────────────

/** The most frequent non-zero value; a tie goes to the larger. */
function modeOf(values) {
  const count = new Map();
  for (const v of values) if (v > 0) count.set(v, (count.get(v) || 0) + 1);
  let best = 0;
  let bestN = 0;
  for (const [v, n] of count) if (n > bestN || (n === bestN && v > best)) { best = v; bestN = n; }
  return best;
}

/**
 * Kaplan families for one gan year, each with its children's months as the
 * collections screen computes them (collection-view), plus what the bank has
 * already been allocated to each month.
 *
 * Registrations are chosen as the collections screen chooses them; the
 * household grouping runs over every Kaplan registration (all years), because
 * that is where the two parents show up separately.
 *
 * `month_totals` — the distinct non-zero monthly totals of the family (the
 * regular month, a prorated first month, a fee change) — is what a one-month
 * transfer can equal. `monthly_expected` is the most common of them.
 */
async function kaplanHouseholds(academicYear) {
  const kaplan = await Branch.findOne({ name: /קפלן/ }).lean();
  if (!kaplan) return [];

  const activeRegIds = (await Child.find({ is_active: true }).select('registration_id').lean()).map(c => c.registration_id);
  const registrations = await Registration.find({
    branch_id: kaplan._id,
    $or: [
      { status: 'completed' },
      { _id: { $in: activeRegIds } },
      { status: 'cancelled', billing_settled: { $ne: true } },
    ],
  }).sort({ child_name: 1 }).lean();
  const regs = registrations.filter(r => academicYearOf(r) === academicYear);
  if (!regs.length) return [];

  const regIds = regs.map(r => r._id);
  const [collections, discounts, camp, children, allocations] = await Promise.all([
    Collection.find({ registration_id: { $in: regIds }, academic_year: academicYear }).lean(),
    Discount.find({ is_active: true, academic_year: academicYear, branch_id: kaplan._id }).lean(),
    SummerCamp.findOne({ academic_year: academicYear, enabled: true, branch_id: kaplan._id }).lean(),
    Child.find({ registration_id: { $in: registrations.map(r => r._id) } }, 'registration_id parent2_name').lean(),
    IncomeAllocation.aggregate([
      { $match: { registration_id: { $in: regIds }, academic_year: academicYear } },
      { $group: { _id: { r: '$registration_id', m: '$month_number' }, total: { $sum: '$amount' } } },
    ]),
  ]);
  const collectionByReg = new Map(collections.map(c => [String(c.registration_id), c]));
  const allocatedOf = new Map(allocations.map(a => [`${a._id.r}|${a._id.m}`, a.total]));

  const householdOf = buildHouseholds(registrations);
  const parentsByHousehold = new Map();
  const addParent = (hk, name) => {
    const n = String(name || '').trim();
    if (!hk || !n) return;
    if (!parentsByHousehold.has(hk)) parentsByHousehold.set(hk, new Set());
    parentsByHousehold.get(hk).add(n);
  };
  const regById = new Map(registrations.map(r => [String(r._id), r]));
  for (const r of registrations) addParent(householdOf(r), r.parent_name);
  for (const c of children) {
    const r = regById.get(String(c.registration_id));
    if (r) addParent(householdOf(r), c.parent2_name);
  }

  const siblingsByHousehold = new Map();
  for (const r of regs) {
    const hk = householdOf(r);
    if (!hk) continue;
    if (!siblingsByHousehold.has(hk)) siblingsByHousehold.set(hk, []);
    siblingsByHousehold.get(hk).push({ reg: r, collection: collectionByReg.get(String(r._id)) || null });
  }

  const out = [];
  for (const [hk, members] of siblingsByHousehold) {
    const kids = members.map(({ reg, collection }) => {
      const { months, campCell } = buildRegistrationMonths({
        reg,
        academicYear,
        collection,
        discounts,
        camp,
        siblings: members.filter(s => String(s.reg._id) !== String(reg._id)),
      });
      const cells = [...months.map(m => ({ month_number: m.month, expected: m.expected_amount, receipt: m.receipt_number }))];
      if (campCell) cells.push({ month_number: CAMP_MONTH, expected: campCell.expected_amount, receipt: campCell.receipt_number });
      return {
        registration_id: reg._id,
        child_name: reg.child_name,
        months: cells.map(c => ({
          month_number: c.month_number,
          expected: round2(c.expected),
          allocated: round2(allocatedOf.get(`${reg._id}|${c.month_number}`) || 0),
          receipt: c.receipt || null,
        })),
      };
    });
    const totals = ACADEMIC_MONTHS.map(m => round2(kids.reduce((s, k) => s + (k.months.find(x => x.month_number === m)?.expected || 0), 0)));
    out.push({
      household_key: hk,
      parents: [...(parentsByHousehold.get(hk) || [])],
      children: kids,
      monthly_expected: modeOf(totals),
      month_totals: [...new Set(totals.filter(t => t > 0))],
    });
  }
  return out;
}

// ── scoring ─────────────────────────────────────────────────────────────────

/** Open = expected beyond what the bank was already allocated. */
const openOf = (m) => round2((m.expected || 0) - (m.allocated || 0));

/** Months (by number) in which any of the family's children still owes. */
function openMonths(household) {
  const set = new Set();
  for (const c of household.children || []) for (const m of c.months || []) if (openOf(m) > 0) set.add(m.month_number);
  return set;
}

const aliasHousehold = (aliases, pk) => {
  if (!pk || !aliases) return null;
  if (aliases instanceof Map) return aliases.get(pk) || null;
  return (aliases.find(a => a.payer_key === pk) || {}).household_key || null;
};

/**
 * Owner's ruling (constraints.md): name overlap ≥0.6 → +40, >0 → +15 (best
 * over the family's parents); amount = a monthly total ±2 ₪ → +45, = 2× or
 * 3× the monthly expected → +30; transfer in the billing month or the one
 * before → +15. A remembered payer text for this family → 100.
 */
function scoreIncome(tx, household, aliases) {
  if (aliasHousehold(aliases, payerKey(tx)) === household.household_key) {
    return { score: 100, reasons: ['משלם מוכר'] };
  }
  let score = 0;
  const reasons = [];

  const text = txText(tx);
  const overlap = Math.max(0, ...(household.parents || []).map(p => nameOverlap(p, text)));
  if (overlap >= 0.6) { score += 40; reasons.push('שם ההורה בתנועה'); } else if (overlap > 0) { score += 15; reasons.push('שם דומה'); }

  const paid = remainingOf(tx);
  const near = (v) => v > 0 && Math.abs(paid - v) <= AMOUNT_TOLERANCE_ILS;
  const monthly = Number(household.monthly_expected) || 0;
  const oneMonth = household.month_totals && household.month_totals.length ? household.month_totals : [monthly];
  if (oneMonth.some(near)) { score += 45; reasons.push('סכום חודש של המשפחה'); } else {
    const k = [2, 3].find(n => near(monthly * n));
    if (k) { score += 30; reasons.push(`סכום של ${k} חודשים`); }
  }

  const month = Number(String(tx.date || '').slice(5, 7));
  if (month >= 1 && month <= 12) {
    const open = openMonths(household);
    // The month after August is the next gan year — not this family's bill.
    const next = month === 8 ? null : (month % 12) + 1;
    if (open.has(month) || (next && open.has(next))) { score += 15; reasons.push('בחודש הגבייה'); }
  }

  return { score: Math.min(100, score), reasons };
}

// ── split ───────────────────────────────────────────────────────────────────

/** A deep-enough copy of the family's month state, so proposals can consume it. */
const ledgerOf = (household) => household.children.map(c => ({
  registration_id: c.registration_id,
  child_name: c.child_name,
  months: c.months.map(m => ({ ...m })),
}));

/**
 * Default split: the earliest open months across the family's children, in
 * gan-year order (September first, the camp last), until the amount is used.
 * Consumes the ledger it is given, so successive transfers fill successive
 * months. Σ split ≤ amount.
 */
function splitInto(ledger, amount) {
  let left = round2(amount);
  const split = [];
  const cells = [];
  for (const c of ledger) for (const m of c.months) cells.push({ c, m });
  cells.sort((a, b) => monthOrder(a.m.month_number) - monthOrder(b.m.month_number));
  for (const { c, m } of cells) {
    if (left <= 0) break;
    const open = openOf(m);
    if (open <= 0) continue;
    const take = round2(Math.min(open, left));
    m.allocated = round2((m.allocated || 0) + take);
    left = round2(left - take);
    split.push({ registration_id: c.registration_id, child_name: c.child_name, month_number: m.month_number, amount: take });
  }
  return split;
}

const capacityOf = (household) => round2(household.children
  .reduce((s, c) => s + c.months.reduce((t, m) => t + Math.max(0, openOf(m)), 0), 0));

// ── queue ───────────────────────────────────────────────────────────────────

async function context() {
  const [pool, aliasRows, rejRows] = await Promise.all([
    incomePool(),
    IncomePayerAlias.find({}, 'payer_key household_key').lean(),
    IncomeRejection.find({}, 'transaction_id household_key').lean(),
  ]);
  const aliases = new Map(aliasRows.map(a => [a.payer_key, a.household_key]));
  const rejected = new Set(rejRows.map(r => rejKey(r.transaction_id, r.household_key)));
  const byYear = new Map();
  const householdsFor = async (year) => {
    if (!year) return [];
    if (!byYear.has(year)) byYear.set(year, await kaplanHouseholds(year));
    return byYear.get(year);
  };
  return { pool, aliases, rejected, householdsFor };
}

/**
 * One proposal per transfer, households taking as many as their open months
 * allow. Greedy global: best score first; a tie at a transfer's top score
 * between two families is not proposed (the amount alone cannot tell them
 * apart). Splits are then laid out per family in date order, so a family's
 * second transfer pays the month after the first one.
 */
async function incomeQueue() {
  const { pool, aliases, rejected, householdsFor } = await context();
  const why = new Map();
  const cands = [];
  for (const tx of pool.open) {
    const households = await householdsFor(academicYearOfDate(tx.date));
    if (!households.length) { why.set(key(tx), WHY_NO_YEAR); continue; }
    const scored = households
      .filter(h => !rejected.has(rejKey(key(tx), h.household_key)))
      .map(h => ({ tx, household: h, ...scoreIncome(tx, h, aliases) }))
      .filter(c => c.score >= SUGGEST_THRESHOLD)
      .sort((a, b) => b.score - a.score);
    if (scored.length > 1 && scored[0].score === scored[1].score) { why.set(key(tx), WHY_TIE); continue; }
    cands.push(...scored);
  }
  cands.sort((a, b) => b.score - a.score
    || String(a.tx.date).localeCompare(String(b.tx.date))
    || key(a.tx).localeCompare(key(b.tx))
    || a.household.household_key.localeCompare(b.household.household_key));

  const usedTx = new Set();
  const capacity = new Map();
  const won = [];
  for (const c of cands) {
    if (usedTx.has(key(c.tx))) continue;
    const hk = `${academicYearOfDate(c.tx.date)}|${c.household.household_key}`;
    if (!capacity.has(hk)) capacity.set(hk, capacityOf(c.household));
    if (capacity.get(hk) <= 0) continue;
    capacity.set(hk, round2(capacity.get(hk) - remainingOf(c.tx)));
    usedTx.add(key(c.tx));
    won.push(c);
  }

  // Splits: per family, in transfer-date order, on a shared ledger.
  const ledgers = new Map();
  const byDate = [...won].sort((a, b) => String(a.tx.date).localeCompare(String(b.tx.date)) || key(a.tx).localeCompare(key(b.tx)));
  const pairs = byDate.map((c) => {
    const hk = `${academicYearOfDate(c.tx.date)}|${c.household.household_key}`;
    if (!ledgers.has(hk)) ledgers.set(hk, ledgerOf(c.household));
    return { tx: c.tx, household: c.household, score: c.score, reasons: c.reasons, split: splitInto(ledgers.get(hk), remainingOf(c.tx)) };
  });
  pairs.sort((a, b) => b.score - a.score || String(b.tx.date).localeCompare(String(a.tx.date)));

  return {
    pairs,
    unmatched_tx: pool.open.filter(t => !usedTx.has(key(t))).map(t => ({ ...t, why: why.get(key(t)) || WHY_NONE })),
    exempt: pool.exempt,
  };
}

/**
 * Other families for a transfer ("✗ לא זה" — the next five). Not
 * de-duplicated against the queue: the person is overriding. Scored families
 * first, then filled with the nearest monthly amounts. Each comes with the
 * split it would get on today's allocations. Null when the transfer is not in
 * the open pool.
 */
async function alternativesForTx(txId, limit = ALTERNATIVES_LIMIT) {
  if (!mongoose.isValidObjectId(txId)) return null;
  const { pool, aliases, rejected, householdsFor } = await context();
  const tx = pool.open.find(t => key(t) === String(txId));
  if (!tx) return null;
  const households = (await householdsFor(academicYearOfDate(tx.date)))
    .filter(h => !rejected.has(rejKey(key(tx), h.household_key)));
  const paid = remainingOf(tx);
  const distance = (h) => Math.abs((Number(h.monthly_expected) || 0) - paid);
  return households
    .map(h => ({ household: h, ...scoreIncome(tx, h, aliases) }))
    .sort((a, b) => b.score - a.score || distance(a.household) - distance(b.household)
      || a.household.household_key.localeCompare(b.household.household_key))
    .slice(0, limit)
    .map(({ household, score, reasons }) => ({
      household,
      score,
      reasons: score > 0 ? reasons : ['סכום קרוב'],
      split: splitInto(ledgerOf(household), paid),
    }));
}

module.exports = {
  SUGGEST_THRESHOLD,
  academicYearOfDate,
  payerKey,
  incomePool,
  kaplanHouseholds,
  scoreIncome,
  splitInto,
  incomeQueue,
  alternativesForTx,
};
