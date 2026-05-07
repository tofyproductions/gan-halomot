const mongoose = require('mongoose');

const branchSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  address: { type: String, default: '' },
  is_active: { type: Boolean, default: true },

  // Delivery contact shown on the PDF order forms (איש קשר למשלוח).
  delivery_contact_name: { type: String, default: '' },
  delivery_contact_phone: { type: String, default: '' },

  // Attendance / TIMEDOX replacement — per-branch clock integration
  clock_ip: { type: String, default: '' },           // e.g. "10.0.0.3"
  clock_port: { type: Number, default: 4370 },
  agent_secret: { type: String, default: '' },       // shared secret for Pi agent auth
  agent_last_seen_at: { type: Date, default: null }, // updated on heartbeat
  agent_version: { type: String, default: '' },      // reported by agent on heartbeat

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
