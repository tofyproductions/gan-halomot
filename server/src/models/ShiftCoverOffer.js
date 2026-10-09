const mongoose = require('mongoose');

/**
 * "אני פנויה — שבצי אותי": an employee's offer to fill an OPEN gap on the
 * rota. Born from the balance strip's arithmetic — offered to her only when
 * the gap has no internal surplus to drag from — and decided by the branch
 * manager, whose acceptance writes the actual entry through the same
 * validated path every placement takes.
 */
const shiftCoverOfferSchema = new mongoose.Schema({
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  week_start: { type: String, required: true, index: true },
  date: { type: String, required: true },
  window: { type: String, enum: ['am', 'pm'], required: true },
  classroom_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Classroom', required: true },
  classroom_name: { type: String, default: '' },
  employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
  employee_name: { type: String, default: '' },
  status: { type: String, enum: ['pending', 'accepted', 'declined'], default: 'pending', index: true },
  decided_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reject_reason: { type: String, default: '' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

shiftCoverOfferSchema.index({ branch_id: 1, week_start: 1, status: 1 });

module.exports = mongoose.model('ShiftCoverOffer', shiftCoverOfferSchema);
