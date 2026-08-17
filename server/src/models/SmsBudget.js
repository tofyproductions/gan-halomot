const mongoose = require('mongoose');

/**
 * How many text messages one branch may send its families this month.
 *
 * The reason for a cap is not the money, which is small. It is that the SMS
 * account has ONE prepaid balance and every gan draws on it — and the same
 * balance sends the one-time codes parents sign in with. A branch that spends
 * it on three reminders about coats locks a family in another town out of the
 * portal entirely, with no symptom anybody can trace back: the parent's screen
 * just says the code never arrived. The cap is there to keep one branch's
 * enthusiasm inside that branch.
 *
 * TWO ANNOUNCEMENTS TO EVERYONE, per branch, per month — measured in actual
 * messages rather than in sends, so a note to one classroom of twenty costs
 * what it costs and not half the month. `budget` is
 *
 *     2 × (children in the branch) × 2 parents
 *
 * COMPUTED ON THE FIRST OF THE MONTH AND THEN FROZEN. The child count moves on
 * its own — registration at קפלן, the תמ״ת/ClickTac reconciliation at the
 * others — and a live figure would mean a family leaving in the middle of the
 * month retroactively shrinks a budget that has already been spent, and a
 * manager watching a number that changes for reasons she cannot see. A fixed
 * number she can plan against is worth more than a precise one.
 *
 * SPENDING IS NOT STORED HERE. It is summed from the announcements themselves
 * (`delivery.sms_recipients` over the month), so there is no counter to drift
 * out of step with what was actually sent, and no way to be over budget on
 * paper while nothing went out.
 */
const smsBudgetSchema = new mongoose.Schema({
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  // 'YYYY-MM', local. A calendar month, because that is the unit anybody
  // asking "how many did we send" has in mind.
  month: { type: String, required: true },

  budget: { type: Number, required: true },

  // What it was derived from, kept so a manager asking "why is it 400?" gets
  // an answer instead of a number.
  children_counted: { type: Number, default: 0 },
  sends_allowed: { type: Number, default: 2 },

  /**
   * Messages granted on top, by a system_admin, after somebody asked.
   *
   * The escape hatch is deliberately a person and not a rule. Every automatic
   * exception ("double it in an emergency") is an exception somebody will
   * declare on a Tuesday about coats.
   */
  extra_granted: { type: Number, default: 0 },
  extra_reason: { type: String, default: '' },
  granted_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  granted_at: { type: Date, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

smsBudgetSchema.index({ branch_id: 1, month: 1 }, { unique: true });

module.exports = mongoose.model('SmsBudget', smsBudgetSchema);
