const mongoose = require('mongoose');

/**
 * Punch = a single clock event from a TIMEDOX device, forwarded by a Pi agent.
 *
 * - `device_user_sn` is the unique record ID from the clock's internal log
 *   (ZKTeco `userSn`), used for dedup so the agent can safely re-send.
 * - `israeli_id` is the userId on the clock (= the employee's ת"ז) which is
 *   the authoritative matching key to Employee. We store it denormalized so
 *   that unmatched punches (employee not yet imported) are still preserved.
 * - `employee_id` is the resolved link once matched. Punches for unknown
 *   Israeli IDs stay with `employee_id: null` until an employee is created.
 * - `timestamp_source` tells us whether we trust the device time or had to
 *   fall back to the Pi's receive time (node-zklib has a known historical
 *   timestamp bug on TANDEM4 PRO, so for live polling we use server time).
 */
const punchSchema = new mongoose.Schema({
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null, index: true },
  israeli_id: { type: String, required: true, index: true },

  device_user_sn: { type: Number, required: true }, // unique per (branch, clock)
  device_user_id: { type: Number, default: null },  // internal uid on clock (1..N)

  timestamp: { type: Date, required: true, index: true },
  // 'fixed_schedule' = generated from Employee.fixed_schedule for a worker who
  // does not clock in. Real in every other respect (counted, editable, visible
  // in the grid) but regenerable, so the generator can tell its own rows apart.
  timestamp_source: {
    type: String,
    enum: ['device', 'agent_received_at', 'manual', 'fixed_schedule'],
    default: 'agent_received_at',
  },
  // For manual punches: who created it + optional free-text reason.
  manual_note: { type: String, default: '' },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  // Approval workflow for manual punches reported by employees themselves.
  //   - 'auto'     — clock-originated punch or admin-entered manual punch (no review needed)
  // Approval chain (accountant is always the final approver):
  //   - 'auto'              — clock/device punch; counts immediately
  //   - 'pending_manager'   — employee-reported; waits for branch-manager approval
  //   - 'pending_accountant'— manager-approved or manager-created; waits for accountant
  //   - 'approved'          — accountant/admin approved; counts
  //   - 'rejected'          — rejected at any stage (kept for audit; excluded)
  //   - 'pending'           — legacy single-stage value, treated as pending_manager
  // Only {'auto','approved'} are counted in salary.
  approval_status: {
    type: String,
    enum: ['auto', 'pending', 'pending_manager', 'pending_accountant', 'approved', 'rejected'],
    default: 'auto',
    index: true,
  },
  // Stage-1 (branch manager) decision, before it reaches the accountant.
  manager_approved_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  manager_approved_at: { type: Date, default: null },
  // Final (accountant/admin) decision.
  approval_decided_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  approval_decided_at: { type: Date, default: null },
  approval_decided_note: { type: String, default: '' },

  // Raw device state code (0=checkin, 1=checkout, 4/5=overtime in/out, etc.)
  // We do not trust this for pairing — pairing is computed from chronological order.
  state: { type: Number, default: 0 },
  verify_mode: { type: Number, default: 0 }, // 0=unknown, 1=fingerprint, 15=face, etc.

  received_at: { type: Date, default: Date.now, index: true }, // when server got it

  // Operational metadata
  agent_version: { type: String, default: '' },
  ignored: { type: Boolean, default: false }, // admin can mark duplicates / test punches
  ignored_reason: { type: String, default: '' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

// Dedup: a given (branch, device_user_sn) pair is unique — the agent can safely
// re-POST the same punch and we'll upsert without creating duplicates.
punchSchema.index({ branch_id: 1, device_user_sn: 1 }, { unique: true });

// For the "live salary table" view we need fast per-employee chronological reads.
punchSchema.index({ employee_id: 1, timestamp: -1 });

module.exports = mongoose.model('Punch', punchSchema);
