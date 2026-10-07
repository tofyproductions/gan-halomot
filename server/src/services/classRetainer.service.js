const { ClassProgram, ClassSession } = require('../models');

/**
 * ריטיינר — a provider paid a fixed sum every month "for N meetings", and the
 * year-end settlement that tells whether that sum was right.
 *
 * The month is paid flat regardless of the calendar: four Mondays, three or
 * five, the invoice is the same. That is the agreement and the system does not
 * argue with it. What it does is keep count, so that at the end of the period
 * the question "did we pay for what she did?" has an exact answer instead of a
 * feeling:
 *
 *   value of a meeting  = monthly_fee / meetings_per_month
 *   paid                = months in the period so far × monthly_fee
 *   earned              = meetings actually held × value of a meeting
 *   balance             = paid − earned
 *       > 0  she owes the gan a credit (קיזוז)
 *       < 0  the gan owes her the difference (השלמה)
 *
 * A partial meeting counts as the fraction it was paid at; a no-show and a
 * postponed meeting count nothing — the postponed one is counted on the day it
 * actually happens, which is the whole point of postponing.
 *
 * A MEETING IS A VISIT, not a group. A provider who takes four groups on one
 * morning came once, and the retainer's "4 meetings a month" means four such
 * mornings. Each group's session is therefore worth 1 / (groups she has at
 * that branch) of a meeting: a morning where she took one group of four counts
 * as a quarter, and the group she made up on another day adds its quarter then.
 *
 * The forecast adds the meetings still on the calendar, as if they happen, so
 * the balance can be seen coming in March rather than discovered in July.
 */

function ymOf(d = new Date()) {
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }).slice(0, 7);
}

/** Every 'YYYY-MM' from a to b inclusive. Empty if b is before a. */
function monthsBetween(a, b) {
  const out = [];
  if (!/^\d{4}-\d{2}$/.test(a) || !/^\d{4}-\d{2}$/.test(b)) return out;
  let [y, m] = a.split('-').map(Number);
  const [ey, em] = b.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

const round2 = (n) => Math.round(n * 100) / 100;

function isRetainer(provider) {
  return provider?.billing?.mode === 'monthly' && Number(provider.billing.monthly_fee) > 0;
}

/** What a single meeting is worth under the retainer. */
function unitValue(provider) {
  const b = provider.billing || {};
  const per = Number(b.meetings_per_month) || 4;
  return Number(b.monthly_fee) / per;
}

/** Is this month inside the paid period? Open-ended ends count as "yes". */
function inPeriod(provider, month) {
  const b = provider.billing || {};
  if (b.period_start && month < b.period_start) return false;
  if (b.period_end && month > b.period_end) return false;
  return true;
}

/** How much of a meeting a session counts for. */
function weightOf(s) {
  if (s.status === 'occurred') return 1;
  if (s.status === 'partial') {
    const rate = Number(s.rate) || 0;
    const amt = Number(s.partial_amount);
    if (rate > 0 && Number.isFinite(amt)) return Math.max(0, Math.min(1, amt / rate));
    return 0.5;
  }
  return 0;
}

/**
 * How many groups make one visit, per branch: the provider's active programs
 * there. Never 0, so a session at a branch with no active program (a program
 * closed mid-year) still counts as a whole meeting rather than vanishing.
 */
async function groupsPerVisit(providerId) {
  const programs = await ClassProgram.find({ provider_id: providerId, is_active: { $ne: false } })
    .select('branch_id').lean();
  const map = new Map();
  for (const p of programs) {
    const k = String(p.branch_id);
    map.set(k, (map.get(k) || 0) + 1);
  }
  return map;
}

/** The share of a meeting one group's session is worth. */
function visitShare(groups, branchId) {
  return 1 / (groups.get(String(branchId)) || 1);
}

/**
 * The settlement, as of a month (default: this one).
 *
 * Refuses to guess a period: without period_start there is no way to say how
 * many months were paid, and a settlement on a guessed count is a wrong number
 * that looks exact.
 */
async function settlement(provider, { asOf = ymOf() } = {}) {
  const b = provider.billing || {};
  if (!isRetainer(provider)) return { ok: false, reason: 'not_retainer' };
  if (!b.period_start) return { ok: false, reason: 'no_period' };

  const periodEnd = b.period_end || asOf;
  const paidThrough = periodEnd < asOf ? periodEnd : asOf;
  const paidMonths = monthsBetween(b.period_start, paidThrough);
  const allMonths = monthsBetween(b.period_start, periodEnd);

  const unit = unitValue(provider);
  const programs = await ClassProgram.find({ provider_id: provider._id }).select('_id').lean();
  const sessions = programs.length
    ? await ClassSession.find({
      program_id: { $in: programs.map(p => p._id) },
      date: { $gte: `${b.period_start}-01`, $lte: `${periodEnd}-31` },
    }).select('date status rate partial_amount branch_id').lean()
    : [];
  const groups = await groupsPerVisit(provider._id);

  const byMonth = new Map(allMonths.map(m => [m, { month: m, held: 0, no_show: 0, scheduled: 0 }]));
  for (const s of sessions) {
    const m = s.date.slice(0, 7);
    const row = byMonth.get(m);
    if (!row) continue;
    const share = visitShare(groups, s.branch_id);
    row.held += weightOf(s) * share;
    if (s.status === 'no_show') row.no_show += share;
    if (s.status === 'scheduled') row.scheduled += share;
  }

  const months = [...byMonth.values()].map(r => ({
    ...r,
    held: round2(r.held),
    no_show: round2(r.no_show),
    scheduled: round2(r.scheduled),
    paid: paidMonths.includes(r.month) ? Number(b.monthly_fee) : 0,
    expected: Number(b.meetings_per_month) || 4,
  }));

  const held = months.filter(r => paidMonths.includes(r.month)).reduce((t, r) => t + r.held, 0);
  const paid = paidMonths.length * Number(b.monthly_fee);
  const earned = held * unit;

  // Forecast to the end of the period: every month paid, every meeting still
  // on the calendar assumed to happen.
  const heldAll = months.reduce((t, r) => t + r.held + r.scheduled, 0);
  const paidAll = allMonths.length * Number(b.monthly_fee);

  return {
    ok: true,
    unit_value: round2(unit),
    monthly_fee: Number(b.monthly_fee),
    meetings_per_month: Number(b.meetings_per_month) || 4,
    period_start: b.period_start,
    period_end: periodEnd,
    as_of: paidThrough,
    to_date: {
      months_paid: paidMonths.length,
      paid: round2(paid),
      meetings_held: round2(held),
      meetings_paid_for: paidMonths.length * (Number(b.meetings_per_month) || 4),
      earned: round2(earned),
      balance: round2(paid - earned),   // > 0 she owes credit, < 0 the gan owes
    },
    forecast: {
      months: allMonths.length,
      paid: round2(paidAll),
      meetings: round2(heldAll),
      earned: round2(heldAll * unit),
      balance: round2(paidAll - heldAll * unit),
    },
    months,
  };
}

module.exports = {
  settlement, isRetainer, unitValue, inPeriod, monthsBetween, weightOf, ymOf,
  groupsPerVisit, visitShare,
};
