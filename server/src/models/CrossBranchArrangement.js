const mongoose = require('mongoose');

/**
 * "She is with us every Monday 13:00–17:00" — agreed by both managers, so
 * those placements stop asking for approval every week.
 */
const crossBranchArrangementSchema = new mongoose.Schema({
  employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
  employee_name: { type: String, default: '' },
  home_branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  host_branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  weekday: { type: Number, min: 0, max: 6, required: true },
  start_hhmm: { type: String, required: true },
  end_hhmm: { type: String, required: true },
  status: { type: String, enum: ['proposed', 'active', 'cancelled'], default: 'proposed', index: true },
  host_confirmed: { type: Boolean, default: false },
  home_confirmed: { type: Boolean, default: false },
  cancelled_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

module.exports = mongoose.model('CrossBranchArrangement', crossBranchArrangementSchema);
