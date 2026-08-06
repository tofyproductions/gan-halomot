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
 * WHO decides is two-stage. The branch manager is the one who actually knows
 * what happened that day, so she labels it — but her decision lands as
 * `pending` and bills nothing until the accountant or an admin confirms it.
 * An accountant/admin labelling a day approves it outright. So:
 *
 *   approved doc  → resolved, billed by the labels
 *   pending doc   → a manager's proposal; still shown as an open issue and
 *                   still blocks the accountant send, but pre-filled for the
 *                   one-click confirmation
 *   no doc        → nobody has looked at it; shown provisionally (first→last)
 */
const punchResolutionSchema = new mongoose.Schema({
  employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
  date: { type: String, required: true },            // 'YYYY-MM-DD' (Israel-local)
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
  status: { type: String, enum: ['pending', 'approved'], default: 'approved' },
  // Who proposed it, when the proposer isn't the approver (branch manager).
  proposed_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  proposed_by_name: { type: String, default: '' },
  proposed_at: { type: Date, default: null },
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
