const mongoose = require('mongoose');

/**
 * Who opened what, on the screens that matter.
 *
 * Born out of the 09.10.2026 security review: the write paths left actor
 * stamps on their own records, but a READ — the payslip that was looked at,
 * the registration that was pulled — left nothing, and "האם מישהו ניצל"
 * could only be answered for half the question. One row per request to a
 * sensitive area, written after the response and never in its way: a
 * failure to log must not fail the work being logged.
 *
 * Self-cleaning at 180 days — an audit trail, not an archive.
 */
const auditTrailSchema = new mongoose.Schema({
  area: { type: String, required: true, index: true },        // 'payroll' | 'registration' | ...
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  user_name: { type: String, default: '' },
  role: { type: String, default: '' },
  method: { type: String, default: 'GET' },
  path: { type: String, default: '' },                        // originalUrl, truncated
  status: { type: Number, default: 0 },                       // 403s are the interesting ones
  ip: { type: String, default: '' },
  created_at: { type: Date, default: Date.now },
});

auditTrailSchema.index({ created_at: -1 });
auditTrailSchema.index({ created_at: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

module.exports = mongoose.model('AuditTrail', auditTrailSchema);
