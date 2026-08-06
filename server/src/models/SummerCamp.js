const mongoose = require('mongoose');

/**
 * קייטנה — the August summer camp, charged on top of the twelve monthly fees.
 *
 * It is a per-branch, per-year arrangement: some branches run one and some
 * don't, and the dates move every year, so the config cannot live on Branch
 * (no year axis) and cannot be a constant. One document per branch per
 * academic year; no document (or enabled=false) means that branch simply has
 * no camp that year and the column never appears for its children.
 *
 * The money itself is NOT stored here. It rides on the existing
 * Collection.months machinery as the pseudo-month CAMP_MONTH (13) — so
 * receipts, sibling-shared receipts, duplicate-receipt detection, per-child
 * fee overrides and the collection history all work on the camp exactly as
 * they do on a real month, with no parallel implementation to keep in sync.
 * `amount` here is only the default the column starts from.
 */
const summerCampSchema = new mongoose.Schema({
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  academic_year: { type: String, required: true }, // normalized 'YYYY-YYYY'

  enabled: { type: Boolean, default: true },
  label: { type: String, default: 'קייטנה' },      // column header, e.g. 'קייטנת אוגוסט'

  start_date: { type: Date, default: null },
  end_date: { type: Date, default: null },

  // Default charge per child. A parent paying something else is handled by the
  // per-child fee override on the camp cell, exactly like any other month.
  amount: { type: Number, default: 0 },

  notes: { type: String, default: '' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

summerCampSchema.index({ branch_id: 1, academic_year: 1 }, { unique: true });

module.exports = mongoose.model('SummerCamp', summerCampSchema);
