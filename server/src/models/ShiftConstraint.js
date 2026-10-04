const mongoose = require('mongoose');

/**
 * אילוץ — what an employee asks the manager to take into account for one day.
 *
 * One document per request, never deleted: a cancelled or rejected constraint
 * is history the manager and the employee both look back at. Swaps carry the
 * colleague (chosen, or picked by the manager from volunteers); volunteers are
 * stored here and shown to managers only.
 */
const fileSchema = new mongoose.Schema({
  name: { type: String, default: '' },
  mimetype: { type: String, default: '' },
  size: { type: Number, default: 0 },
  storage_key: { type: String, default: '' },
  file_data: { type: String, default: '' }, // base64, only when no bucket is configured
}, { _id: false });

const shiftConstraintSchema = new mongoose.Schema({
  employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
  employee_name: { type: String, default: '' },
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  type: { type: String, enum: ['day_off', 'partial', 'sick_expected', 'other', 'move_day', 'swap'], required: true },
  date: { type: String, required: true },
  target_date: { type: String, default: null },
  week_start: { type: String, required: true, index: true },
  from_hhmm: { type: String, default: '' },
  to_hhmm: { type: String, default: '' },
  details: { type: String, default: '' },
  swap_mode: { type: String, enum: ['handover', 'mutual', null], default: null },
  colleague_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
  broadcast: { type: Boolean, default: false },
  volunteers: { type: [mongoose.Schema.Types.ObjectId], default: [] },
  files: { type: [fileSchema], default: [] },
  status: {
    type: String,
    enum: ['pending_colleague', 'pending_broadcast', 'broadcast', 'open', 'accepted', 'rejected', 'declined', 'cancelled'],
    default: 'open', index: true,
  },
  decided_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  decided_by_name: { type: String, default: '' },
  decided_at: { type: Date, default: null },
  decided_auto: { type: Boolean, default: false },
  reject_reason: { type: String, default: '' },
  employee_request_id: { type: mongoose.Schema.Types.ObjectId, ref: 'EmployeeRequest', default: null },
  cancelled_at: { type: Date, default: null },
  cancelled_after_publish: { type: Boolean, default: false },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

shiftConstraintSchema.index({ branch_id: 1, week_start: 1, status: 1 });

module.exports = mongoose.model('ShiftConstraint', shiftConstraintSchema);
