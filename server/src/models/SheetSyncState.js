const mongoose = require('mongoose');

/**
 * What the old board's sheet held at the end of the last sync pass.
 *
 * Without this, a field that differs between the two systems is
 * unclassifiable — "they changed it" and "we changed it" look identical, and
 * copying either way destroys a real edit. See services/sheet-sync/three-way.js.
 *
 * One document per branch per day, same key as the board's own query. It is
 * disposable: deleting it costs one pass, which re-reads the sheet and treats
 * everything in it as the truth, exactly like a first run.
 *
 * `shadow` is a map of accessId → { <DailyLog dotted path>: value }.
 */
const sheetSyncStateSchema = new mongoose.Schema({
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  // YYYY-MM-DD, local. Same reasoning as DailyLog: a day is a calendar day.
  date: { type: String, required: true, index: true },
  sheet_id: { type: String, default: '' },

  shadow: { type: mongoose.Schema.Types.Mixed, default: {} },

  last_run_at: { type: Date, default: null },
  last_error: { type: String, default: '' },
  conflicts_count: { type: Number, default: 0 },
  wrote_in: { type: Number, default: 0 },
  wrote_out: { type: Number, default: 0 },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

sheetSyncStateSchema.index({ branch_id: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('SheetSyncState', sheetSyncStateSchema);
