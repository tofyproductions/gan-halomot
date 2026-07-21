const mongoose = require('mongoose');

/**
 * PunchResolution — the accountant's/admin's decision for a day that has MORE
 * THAN TWO punches (a clock double-read, a manual punch layered on a real one,
 * or a genuine multi-session in-out-in-out day).
 *
 * Each punch that day is labelled in / out / ignore; billing walks them
 * chronologically and pays Σ(in→out), never the out→in gaps. Until such a day
 * has an approved resolution it is shown provisionally (first→last span) and
 * flagged for review — it is NEVER silently trusted.
 *
 * Presence of an approved doc = resolved. Absence for a >2-punch day = pending.
 */
const punchResolutionSchema = new mongoose.Schema({
  employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
  date: { type: String, required: true },            // 'YYYY-MM-DD' (Israel-local)
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
  status: { type: String, enum: ['approved'], default: 'approved' },
  labels: {
    type: [{
      punch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Punch', required: true },
      role: { type: String, enum: ['in', 'out', 'ignore'], required: true },
    }],
    default: [],
  },
  minutes: { type: Number, default: 0 },             // computed billed minutes (for reference)
  note: { type: String, default: '' },
  resolved_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  resolved_at: { type: Date, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

punchResolutionSchema.index({ employee_id: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('PunchResolution', punchResolutionSchema);
