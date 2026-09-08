const mongoose = require('mongoose');

/**
 * One upload of one enrollment file.
 *
 * Both lists are republished through the summer — the ministry's as families
 * are approved and withdrawn, ClickTac's as families register and cancel — so
 * "what changed since last time" is a question that gets asked at every upload
 * and cannot be answered by the current state alone.
 *
 * The batch is the answer: it records what the file did, not what it said.
 * Rows added, rows whose meaning changed, and rows that were here last time
 * and are gone from this file.
 */
const enrollmentImportSchema = new mongoose.Schema({
  source: { type: String, enum: ['tmt', 'clicktac'], required: true, index: true },

  /**
   * WHICH ClickTac export this upload was.
   *
   * The vendor publishes two, they go through the same button, and they bring
   * different halves of the child — so "when was the last ClickTac file
   * uploaded" is two questions, not one. A branch can be fully up to date on
   * registrations and three weeks stale on contracts, and before this field
   * existed the history could not say so.
   *
   * Meaningless for source 'tmt', which has one file; it keeps the default
   * rather than being made conditional, since nothing reads it there.
   */
  export_type: {
    type: String,
    enum: ['registrations', 'contracts'],
    default: 'registrations',
    index: true,
  },
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  academic_year: { type: String, required: true, index: true },

  file_name: { type: String, default: '' },
  sheet_name: { type: String, default: '' },
  rows: { type: Number, default: 0 },      // rows in the sheet
  parsed: { type: Number, default: 0 },    // rows that were enrollments

  created: { type: Number, default: 0 },
  updated: { type: Number, default: 0 },
  unchanged: { type: Number, default: 0 },
  // Children this branch/year had before and that this file no longer lists.
  missing: { type: Number, default: 0 },

  /**
   * The names behind the counts, so the summary is readable without a second
   * query. Capped at what a person will actually read; the full picture is
   * always the records themselves.
   */
  details: {
    created: [{ type: String }],
    updated: [{ name: String, changes: [String], _id: false }],
    missing: [{ type: String }],
  },

  imported_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

enrollmentImportSchema.index({ branch_id: 1, academic_year: 1, source: 1, created_at: -1 });

module.exports = mongoose.model('EnrollmentImport', enrollmentImportSchema);
