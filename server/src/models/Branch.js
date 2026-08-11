const mongoose = require('mongoose');

const branchSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  address: { type: String, default: '' },
  is_active: { type: Boolean, default: true },

  // Delivery contact shown on the PDF order forms (איש קשר למשלוח).
  delivery_contact_name: { type: String, default: '' },
  delivery_contact_phone: { type: String, default: '' },

  // Visual color (one of the keys in client/src/utils/branchColors.js).
  // Drives the section header tint in attendance/payroll/employee views.
  // When empty, the UI falls back to a position-based color.
  color: { type: String, default: '' },

  // Legal entity (amuta) this branch belongs to. Drives how punched hours are
  // bucketed in the monthly payroll table: hours at branch X go under the
  // amuta column for X. A single branch belongs to exactly one amuta.
  amuta_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Amuta', default: null, index: true },

  /**
   * Is this gan supervised by משרד התמ"ת?
   *
   * A supervised branch enrolls through the ministry's national registration
   * and through קליקטאק, and a child needs BOTH to be admitted — which is what
   * the תמ"ת reconciliation screen checks. קפלן is the exception: its families
   * register directly with us, it is not in ClickTac and it has no ministry
   * list, so reconciling it would report every child in the gan as an anomaly.
   *
   * null means "never set". Rows written before this field existed fall back
   * to the branch name, and the fallback stops mattering the moment somebody
   * saves the branch.
   */
  tmt_supervised: { type: Boolean, default: null },

  /**
   * How many children this gan is licensed to hold — the ministry's number,
   * not ours.
   *
   * It is handed to the operator and typed in here; nothing computes it. It is
   * kept apart from the sum of the classrooms' own capacities because the two
   * are different facts and they do disagree: the rooms can be set up for more
   * places than the licence allows, and the placement screen has to be able to
   * say so rather than quietly average them.
   */
  licensed_capacity: { type: Number, default: null },

  // Attendance / TIMEDOX replacement — per-branch clock integration
  clock_ip: { type: String, default: '' },           // e.g. "10.0.0.3"
  clock_port: { type: Number, default: 4370 },
  agent_secret: { type: String, default: '' },       // shared secret for Pi agent auth
  agent_last_seen_at: { type: Date, default: null }, // updated on heartbeat
  agent_version: { type: String, default: '' },      // reported by agent on heartbeat

  // Clock health, reported by the agent heartbeat. Drives the "clock down"
  // alert when the clock is unreachable while the agent is still alive (DHCP IP
  // change, clock powered off) — the failure that silently hid the May 2026 outage.
  clock_reachable: { type: Boolean, default: null },     // last heartbeat's clock probe
  clock_last_ok_at: { type: Date, default: null },       // last time clock was reachable
  clock_log_count: { type: Number, default: null },      // device record count
  clock_last_user_sn: { type: Number, default: null },   // agent's last_user_sn baseline
  clock_alerted_at: { type: Date, default: null },       // last "clock down" email sent
  // A server-side watchdog alerts when the AGENT (Pi) itself goes silent — no
  // heartbeats at all. The heartbeat-driven clock-down alert can't catch this
  // (a dead agent sends nothing), which is exactly how the Moshe Dayan June 2026
  // 5-day gap went unnoticed. This stamps the last "agent silent" email sent.
  agent_alerted_at: { type: Date, default: null },

  // Cached snapshot of the list of users stored on the TIMEDOX device,
  // captured by an on-demand dump from the Pi agent. Used by the admin UI
  // to match clock users to payroll employees during onboarding.
  //
  // Shape per entry:
  //   { uid: 61, user_id: "324235241", password: "7001", cardno: 0, role: 0 }
  //
  // `user_id` is always normalized to 9 digits (left-padded with a leading
  // zero where the device stripped it). The `name` field from the device
  // is NOT cached because it is garbled on this firmware.
  clock_users: { type: [mongoose.Schema.Types.Mixed], default: [] },
  clock_users_updated_at: { type: Date, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

module.exports = mongoose.model('Branch', branchSchema);
