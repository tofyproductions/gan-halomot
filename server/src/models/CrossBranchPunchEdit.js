const mongoose = require('mongoose');

/**
 * A punch correction one branch's manager asked for on an employee whose
 * HOME branch is somebody else's — שילו בגים clocking a real day at הרצליה
 * while her manager sits at כפר סבא, and the הרצליה manager fixing a wrong
 * time for a shift she watched happen.
 *
 * Punch.pending_edit (see models/Punch.js) is where the actual correction
 * waits and is what payroll and the approve/reject endpoints act on — this
 * collection does NOT duplicate that authority. It is purely the log the
 * home manager's "עובדים שלי בסניפים אחרים" screen reads: a request is
 * created here the moment editPunch stages a cross-branch correction, and is
 * UPDATED in place (never re-created) as approvePunch/rejectPunch move the
 * underlying punch through manager → accountant → done. Names and branches
 * are snapshotted at request time on purpose — a manager reassigned in
 * October must not rewrite what August's log says happened.
 */
const crossBranchPunchEditSchema = new mongoose.Schema({
  punch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Punch', required: true, index: true },
  employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null, index: true },
  employee_name: { type: String, default: '' },

  // Where the punch physically happened — the manager who asked for the fix.
  host_branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  host_branch_name: { type: String, default: '' },
  // The employee's own branch — whose manager has to sign off.
  home_branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  home_branch_name: { type: String, default: '' },

  requested_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  requested_by_name: { type: String, default: '' },
  requested_at: { type: Date, default: Date.now },
  prev_timestamp: { type: Date, default: null },
  requested_timestamp: { type: Date, default: null },
  note: { type: String, default: '' },

  /**
   * 'pending_manager'    — waiting on a manager of home_branch_id.
   * 'pending_accountant' — the home manager signed off; waiting on Accounting.
   * 'approved' / 'rejected' — closed, kept for the month's history.
   */
  status: {
    type: String,
    enum: ['pending_manager', 'pending_accountant', 'approved', 'rejected'],
    default: 'pending_manager',
    index: true,
  },
  manager_decided_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  manager_decided_by_name: { type: String, default: '' },
  manager_decided_at: { type: Date, default: null },
  // Whoever closed it — Accounting approving, or a rejection at either stage.
  final_decided_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  final_decided_by_name: { type: String, default: '' },
  final_decided_at: { type: Date, default: null },
  final_decided_note: { type: String, default: '' },

  // 'YYYY-MM' in Israel local time, off requested_at — how the log groups by month.
  month: { type: String, required: true, index: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

crossBranchPunchEditSchema.index({ home_branch_id: 1, month: 1 });
crossBranchPunchEditSchema.index({ employee_id: 1, month: 1 });

module.exports = mongoose.model('CrossBranchPunchEdit', crossBranchPunchEditSchema);
