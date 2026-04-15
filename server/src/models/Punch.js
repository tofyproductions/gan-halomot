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
  timestamp_source: {
    type: String,
    enum: ['device', 'agent_received_at', 'manual'],
    default: 'agent_received_at',
  },
  // For manual punches: who created it + optional free-text reason.
  manual_note: { type: String, default: '' },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

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
