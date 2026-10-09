const mongoose = require('mongoose');

/**
 * A bounty on an open slot: the manager's "שווה לנסוע בשביל זה".
 *
 * Attached to a gap (branch/date/window/class), shown ONLY to staff of
 * OTHER branches — her own people are expected without a prize — and paid
 * by the rules: acceptance files a pending SalaryAdjustment (money_add)
 * that the accountant approves like any other addition. The bonus row here
 * is the offer; the adjustment row is the money.
 */
const shiftCoverBonusSchema = new mongoose.Schema({
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  week_start: { type: String, required: true, index: true },
  date: { type: String, required: true },
  window: { type: String, enum: ['am', 'pm'], required: true },
  classroom_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Classroom', required: true },
  classroom_name: { type: String, default: '' },
  amount: { type: Number, required: true, min: 1 },
  status: { type: String, enum: ['active', 'cancelled'], default: 'active', index: true },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  created_by_name: { type: String, default: '' },
  claimed_by_name: { type: String, default: '' },
  claimed_at: { type: Date, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

shiftCoverBonusSchema.index({ branch_id: 1, week_start: 1, status: 1 });

module.exports = mongoose.model('ShiftCoverBonus', shiftCoverBonusSchema);
