const mongoose = require('mongoose');

/**
 * The office edits a branch's rota only through its manager.
 *
 * She is the one who answers for who stands in which room, so an admin or the
 * accountant proposes the whole week as they want it, and it lands only when
 * she approves. A rejection carries a reason, same as every other request in
 * the system that a person is told "no" about.
 */
const shiftEditRequestSchema = new mongoose.Schema({
  shift_week_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ShiftWeek', required: true, index: true },
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  entries: { type: [mongoose.Schema.Types.Mixed], default: [] },
  // The week's updated_at when this was filed: approving is refused once the
  // manager has changed the week since, so a request never silently undoes her.
  week_version: { type: Date, default: null },
  // Who the request actually changes, for the manager reading it.
  changed_names: { type: [String], default: [] },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
  requested_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  requested_by_name: { type: String, default: '' },
  decided_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  decided_by_name: { type: String, default: '' },
  decided_at: { type: Date, default: null },
  reject_reason: { type: String, default: '' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

module.exports = mongoose.model('ShiftEditRequest', shiftEditRequestSchema);
