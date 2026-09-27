const mongoose = require('mongoose');

/**
 * What the follow-up already SENT about an issue. The issue itself is never
 * stored (it is recomputed from punches every time); this is only the record
 * that lets the manager see "נשלחה תזכורת ב-…" and stops the same push from
 * going out twice.
 */
const punchFollowupLogSchema = new mongoose.Schema({
  issue_key: { type: String, required: true, index: true }, // `${employee_id}|${date}|${kind}`
  employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  date: { type: String, required: true },
  kind: { type: String, enum: ['missing', 'duplicate', 'empty_day'], required: true },
  action: {
    type: String,
    enum: ['employee_push', 'manager_whatsapp', 'manager_push', 'decision_push'],
    required: true,
  },
  by_user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  at: { type: Date, default: Date.now },
});

punchFollowupLogSchema.index({ employee_id: 1, date: 1 });

module.exports = mongoose.model('PunchFollowupLog', punchFollowupLogSchema);
