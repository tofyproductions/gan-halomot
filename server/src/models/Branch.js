const mongoose = require('mongoose');

const branchSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  address: { type: String, default: '' },
  is_active: { type: Boolean, default: true },

  // Attendance / TIMEDOX replacement — per-branch clock integration
  clock_ip: { type: String, default: '' },           // e.g. "10.0.0.3"
  clock_port: { type: Number, default: 4370 },
  agent_secret: { type: String, default: '' },       // shared secret for Pi agent auth
  agent_last_seen_at: { type: Date, default: null }, // updated on heartbeat
  agent_version: { type: String, default: '' },      // reported by agent on heartbeat
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

module.exports = mongoose.model('Branch', branchSchema);
