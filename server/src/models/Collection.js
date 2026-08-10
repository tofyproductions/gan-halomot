const mongoose = require('mongoose');

const collectionMonthSchema = new mongoose.Schema({
  // 1–12 are calendar months. 13 is the קייטנה pseudo-month (see
  // models/SummerCamp.js): the August camp is a separate charge with its own
  // receipt, and riding on this schema means it inherits receipts, sibling
  // receipts, duplicate detection, fee overrides and history for free.
  month_number: { type: Number, required: true, min: 1, max: 13 },
  expected_amount: { type: Number, default: 0 },
  paid_amount: { type: Number, default: 0 },
  receipt_number: { type: String, default: null },
  payment_status: {
    type: String,
    enum: ['pending', 'expected', 'paid', 'partial', 'exempt', 'overdue'],
    default: 'expected',
  },
  payment_date: { type: Date, default: null },
  is_prorated: { type: Boolean, default: false },
  notes: { type: String, default: null },
  fee_override: { type: Number, default: null },
  fee_override_reason: { type: String, default: null },
}, { _id: true });

const collectionSchema = new mongoose.Schema({
  registration_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Registration', default: null },
  child_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Child', default: null },
  academic_year: { type: String, required: true },
  exit_month: { type: Number, default: null },
  registration_fee_receipt: { type: String, default: null },

  /**
   * Is this child actually in the קייטנה?
   *
   * Deliberately three-state, and deliberately NOT defaulted to true.
   *
   * Every other month rides on the registration: a registered child is in the
   * gan in March, so a receipt the parent paid for one sibling legitimately
   * covers the other. The camp is a separate product that siblings attend
   * separately — and the sibling-receipt inheritance was applying to it
   * anyway, so entering one child's receipt silently marked the other as paid
   * for a camp they were never in, with no way to take it back: the value was
   * derived at read time, not stored, so there was nothing to delete.
   *
   *   true   → attending; behaves like any other month, sibling receipts included
   *   false  → not attending; charged nothing and never inherits a receipt
   *   null   → nobody has said yet. Charged the default so the column still
   *            totals, but marked as unanswered and NOT eligible to inherit a
   *            sibling's receipt — attendance is not something to assume.
   */
  camp_enrolled: { type: Boolean, default: null },
  months: [collectionMonthSchema],
  last_updated: { type: Date, default: Date.now },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

collectionSchema.index({ registration_id: 1, academic_year: 1 });

module.exports = mongoose.model('Collection', collectionSchema);
