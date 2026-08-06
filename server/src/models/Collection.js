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
  months: [collectionMonthSchema],
  last_updated: { type: Date, default: Date.now },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

collectionSchema.index({ registration_id: 1, academic_year: 1 });

module.exports = mongoose.model('Collection', collectionSchema);
