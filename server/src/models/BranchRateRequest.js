const mongoose = require('mongoose');

/**
 * A rate for an employee to work at a branch that is not hers.
 *
 * Her own manager answers first (it is her person being lent out), then the
 * office sets the money. Only then can the host manager place her.
 */
const branchRateRequestSchema = new mongoose.Schema({
  employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
  home_branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  host_branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  proposed_rate: { type: Number, default: null },
  final_rate: { type: Number, default: null },
  status: { type: String, enum: ['pending_home', 'pending_office', 'approved', 'rejected'], default: 'pending_home', index: true },
  requested_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  requested_by_name: { type: String, default: '' },
  home_decided_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  office_decided_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reject_reason: { type: String, default: '' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

module.exports = mongoose.model('BranchRateRequest', branchRateRequestSchema);
