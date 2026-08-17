const { Announcement, SmsBudget } = require('../models');
const { branchChildCount } = require('./announcement-audience.service');

/**
 * What a branch has left to spend on text messages this month.
 *
 * The cap exists because the SMS account has ONE prepaid balance and every gan
 * draws on it — including the one-time codes parents sign in with. A branch
 * that spends it on reminders locks a family in another town out of the portal
 * with no symptom anybody can trace: their screen just says the code never
 * came. See models/SmsBudget.
 *
 * Two announcements to everybody, per branch, per month, measured in ACTUAL
 * MESSAGES so a note to one classroom costs what it costs.
 */

const SENDS_ALLOWED = 2;
const PARENTS_PER_CHILD = 2;

/** 'YYYY-MM' for a date, in local time — the month anybody asking has in mind. */
function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** First and last instant of that month, for summing what was sent inside it. */
function monthBounds(key) {
  const [y, m] = key.split('-').map(Number);
  return { from: new Date(y, m - 1, 1), to: new Date(y, m, 1) };
}

/**
 * This month's allowance for a branch, creating it on first sight.
 *
 * FROZEN once written. The child count moves on its own — registration at
 * קפלן, the תמ״ת/ClickTac reconciliation elsewhere — and recomputing on every
 * read would mean a family leaving mid-month retroactively shrinks an
 * allowance that has already been spent, and a manager watching a number that
 * changes for reasons she cannot see. A fixed figure she can plan against is
 * worth more than a precise one.
 *
 * `upsert` with `$setOnInsert` rather than find-then-create: two managers
 * opening the screen at the same moment on the first of the month would
 * otherwise both compute it and one would overwrite the other.
 */
async function ensureBudget(branchId, month = monthKey()) {
  const existing = await SmsBudget.findOne({ branch_id: branchId, month }).lean();
  if (existing) return existing;

  const children = await branchChildCount(branchId);
  const budget = SENDS_ALLOWED * children * PARENTS_PER_CHILD;

  await SmsBudget.updateOne(
    { branch_id: branchId, month },
    {
      $setOnInsert: {
        branch_id: branchId,
        month,
        budget,
        children_counted: children,
        sends_allowed: SENDS_ALLOWED,
      },
    },
    { upsert: true },
  );
  return SmsBudget.findOne({ branch_id: branchId, month }).lean();
}

/**
 * What has actually gone out this month.
 *
 * Summed from the announcements themselves rather than kept as a counter.
 * A counter is a second record of the same fact and drifts from it the first
 * time a send half-fails — this cannot say a branch is over budget while
 * nothing was sent, or the reverse.
 */
async function spentThisMonth(branchId, month = monthKey()) {
  const { from, to } = monthBounds(month);
  const rows = await Announcement.aggregate([
    {
      $match: {
        branch_id: branchId,
        'delivery.sms_sent_at': { $gte: from, $lt: to },
      },
    },
    { $group: { _id: null, sent: { $sum: '$delivery.sms_recipients' } } },
  ]);
  return rows[0]?.sent || 0;
}

/**
 * The whole picture for one branch: allowance, spend, what is left.
 *
 * `remaining` never goes below zero. A negative allowance on a manager's
 * screen is an accusation, and the only thing she can do about it is telephone
 * somebody — which is what the number already tells her to do at zero.
 */
async function budgetFor(branchId, month = monthKey()) {
  const [doc, spent] = await Promise.all([
    ensureBudget(branchId, month),
    spentThisMonth(branchId, month),
  ]);
  const total = (doc.budget || 0) + (doc.extra_granted || 0);
  return {
    month,
    budget: doc.budget || 0,
    extra_granted: doc.extra_granted || 0,
    extra_reason: doc.extra_reason || '',
    total,
    spent,
    remaining: Math.max(0, total - spent),
    children_counted: doc.children_counted || 0,
    sends_allowed: doc.sends_allowed || SENDS_ALLOWED,
  };
}

/**
 * More messages, granted by a person.
 *
 * Additive rather than a new ceiling: "give them another 200" is what is
 * actually being asked, and setting a total means whoever grants it has to
 * first work out what has already been spent.
 */
async function grantExtra({ branchId, month = monthKey(), amount, reason, userId }) {
  await ensureBudget(branchId, month);
  await SmsBudget.updateOne(
    { branch_id: branchId, month },
    {
      $inc: { extra_granted: amount },
      $set: {
        extra_reason: String(reason || '').slice(0, 300),
        granted_by: userId || null,
        granted_at: new Date(),
      },
    },
  );
  return budgetFor(branchId, month);
}

module.exports = {
  budgetFor, ensureBudget, spentThisMonth, grantExtra,
  monthKey, SENDS_ALLOWED, PARENTS_PER_CHILD,
};
