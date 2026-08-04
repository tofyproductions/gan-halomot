const mongoose = require('mongoose');

/**
 * Durable trail for the month-based hours-report distribution. The payslip
 * sends log into their audit document, but hours sends have no audit doc —
 * without this, a job killed mid-run (OOM/restart) left no trace at all
 * ("clicked send and no email ever arrived"). One document per (month × kind),
 * overwritten by each send; `running:true` is written the moment a send is
 * accepted and closed out on finish (or by the boot-time stale finalizer).
 */
const hoursDistributionLogSchema = new mongoose.Schema({
  month: { type: String, required: true },              // 'YYYY-MM'
  kind: { type: String, required: true, enum: ['managers', 'employees'] },
  at: { type: Date, default: Date.now },
  by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  running: { type: Boolean, default: false },
  results: { type: mongoose.Schema.Types.Mixed, default: [] },
}, { timestamps: true });

hoursDistributionLogSchema.index({ month: 1, kind: 1 }, { unique: true });

module.exports = mongoose.model('HoursDistributionLog', hoursDistributionLogSchema);
