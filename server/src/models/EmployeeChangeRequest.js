const mongoose = require('mongoose');

/**
 * A branch manager's edit to an employee card, held for approval.
 *
 * Branch managers may not write Employee documents directly — every field they
 * change is captured here (with the value it had at request time) and only
 * applied to the Employee once an accountant / system_admin approves. This
 * mirrors the PayrollChangeRequest pattern used for the salary table.
 */
const changeSchema = new mongoose.Schema({
  field: { type: String, required: true },      // Employee field name
  label: { type: String, default: '' },         // Hebrew label for the review UI
  before: { type: mongoose.Schema.Types.Mixed, default: null },
  after: { type: mongoose.Schema.Types.Mixed, default: null },
}, { _id: false });

const employeeChangeRequestSchema = new mongoose.Schema({
  employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
  employee_name: { type: String, default: '' },  // snapshot for the review list
  changes: { type: [changeSchema], default: [] },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending',
    index: true,
  },
  requested_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  requested_by_name: { type: String, default: '' },
  reviewed_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reviewed_at: { type: Date, default: null },
  review_note: { type: String, default: '' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

module.exports = mongoose.model('EmployeeChangeRequest', employeeChangeRequestSchema);
