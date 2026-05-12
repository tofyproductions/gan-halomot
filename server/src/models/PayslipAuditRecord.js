const mongoose = require('mongoose');

/**
 * Persisted record of one payslip audit run.
 *
 * Each time the user clicks "הרץ בדיקה" we save a snapshot containing the
 * full audit result (so it can be re-opened later without re-uploading the
 * source files), a summary for the history list, and metadata about who ran
 * it and which files were used.
 *
 * `full_result` holds the same JSON shape returned by /payslip-audit/run-multi
 * (minus payslip raw_text, which is already stripped server-side).
 */
const payslipAuditSchema = new mongoose.Schema(
  {
    created_at: { type: Date, default: Date.now, index: true },
    created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    created_by_name: { type: String, default: '' },

    // Period + branches covered — used in the history list as the headline.
    year_month: { type: String, default: null, index: true },     // "2026-04"
    table_sheet_name: { type: String, default: null },
    branches: { type: [String], default: [] },

    // Source filenames, for traceability when reopening an old audit
    table_filename: { type: String, default: '' },
    payslip_files: {
      type: [{
        branch: String,
        filename: String,
      }],
      default: [],
    },

    // Quick-glance counts for the history list (avoid loading full_result)
    summary: {
      rows_in_table:    { type: Number, default: 0 },
      payslips_in_pdf:  { type: Number, default: 0 },
      critical_count:   { type: Number, default: 0 },
      warning_count:    { type: Number, default: 0 },
      missing_count:    { type: Number, default: 0 },
      orphan_count:     { type: Number, default: 0 },
    },

    // Whole audit result — opened with GET /payslip-audit/history/:id
    full_result: { type: mongoose.Schema.Types.Mixed, required: true },

    // ── Approved-cycle workflow (Phase 3) ──
    // Once the accountant returns the corrected payslips and the manager
    // verifies them, the audit is "closed" by marking it approved + uploading
    // the final corrected PDFs. Future audits can compare against these.
    approved: { type: Boolean, default: false, index: true },
    approved_at: { type: Date, default: null },
    approved_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approved_by_name: { type: String, default: '' },
    approved_payslip_files: {
      type: [{
        branch: String,
        filename: String,  // original upload name
        // path on disk relative to PDF_STORAGE_DIR (controller builds the abs path)
      }],
      default: [],
    },
    approved_note: { type: String, default: '' },  // optional admin remarks
  },
  { collection: 'payslip_audits' }
);

// Helpful for "show my latest audits" sorted by date
payslipAuditSchema.index({ created_at: -1 });

module.exports = mongoose.model('PayslipAuditRecord', payslipAuditSchema);
