const mongoose = require('mongoose');

/** One run of the iCount mirror pull. The screen calls the mirror stale if the last one is missing or not complete. */
const icountPullSchema = new mongoose.Schema({
  started_at: { type: Date, default: Date.now },
  finished_at: { type: Date, default: null },
  date_from: { type: String, default: '' },
  suppliers_total: { type: Number, default: 0 },
  suppliers_read: { type: Number, default: 0 },
  rows_seen: { type: Number, default: 0 },
  upserted: { type: Number, default: 0 },
  gone: { type: Number, default: 0 },
  foreign: { type: Number, default: 0 }, // rows iCount returned under another supplier — skipped
  // Mass-void brake: this many rows looked gone, NONE were marked (more than 20, or more than 30% of the known rows).
  gone_suppressed: { type: { _id: false, count: Number, reason: String }, default: null },
  // A throttled pull stopped here; the next one starts at this supplier and wraps around. '' = start at the top.
  resume_supplier_id: { type: String, default: '' },
  complete: { type: Boolean, default: false },
  failures: { type: [{ _id: false, supplier: String, reason: String }], default: [] },
  error: { type: String, default: '' },
});

icountPullSchema.index({ started_at: -1 });

module.exports = mongoose.model('IcountPull', icountPullSchema);
