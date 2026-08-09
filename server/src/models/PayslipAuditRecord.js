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

    // ── Correction rounds ──
    //
    // After the corrections email goes out, the accountant returns fixed
    // payslips. Re-running a whole audit for that meant re-uploading the salary
    // table and re-reading all 27 payslips, which buried the only question that
    // mattered: were MY notes actually acted on. A round re-reads just the
    // employees that were flagged, against the table already stored here, and
    // answers that note by note.
    //
    // The round's PDFs live in PayslipAuditPdf under kind 'fix_<round_no>'.
    fix_rounds: {
      type: [{
        round_no: Number,
        created_at: { type: Date, default: Date.now },
        created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        created_by_name: { type: String, default: '' },
        // 'internal' — uploaded from inside the system by the office.
        // 'accountant' — uploaded by the accountant through his upload link.
        source: { type: String, default: 'internal' },
        note: { type: String, default: '' },
        uploaded_files: { type: [{ branch: String, filename: String }], default: [] },
        // One entry per employee that had notes going into this round.
        items: {
          type: [{
            key: String,               // stable id — "id:<tz>" or "nm:<name>::<branch>"
            audit_idx: Number,         // index into full_result.results
            employee_name: String,
            branch: String,
            employee_no: mongoose.Schema.Types.Mixed,
            employee_id: String,
            page_index: Number,        // page in the NEW round PDF, for preview
            // Which uploaded file that page lives in. Undeclared fields are
            // stripped on save, and without this the preview had a page number
            // and no file to take it from.
            round_branch: String,
            matched: { type: Boolean, default: false },  // found in the new PDF at all
            notes: {
              type: [{
                field: String,
                severity: String,
                message: String,       // the note as it was sent to the accountant
                // 'fixed' | 'not_fixed' | 'manual' — what the re-check concluded
                auto_verdict: String,
                // Set by a human when auto_verdict is 'manual', or to overrule it
                manual_verdict: { type: String, default: null },
                still_expected: mongoose.Schema.Types.Mixed,  // values from the re-check
                still_actual: mongoose.Schema.Types.Mixed,
                reply: { type: String, default: '' },         // free-text comment
              }],
              default: [],
            },
            // Findings in the new payslip that were NOT in the original notes —
            // a fix that broke something else.
            new_findings: {
              type: [{ field: String, severity: String, message: String, expected: mongoose.Schema.Types.Mixed, actual: mongoose.Schema.Types.Mixed }],
              default: [],
            },
          }],
          default: [],
        },
        // The re-check in the same shape as an ordinary audit result, so the
        // round can be opened in the main review screen instead of a list.
        // Reading a verdict without the payslip in front of you is guesswork —
        // the screen that pairs each employee with their page already exists.
        audit_view: { type: mongoose.Schema.Types.Mixed, default: null },
        // Signed off: every note in this round was settled. Approving copies
        // the round's PDFs over the audit's 'approved' slot, which is what the
        // distribution reads — so managers and employees get the corrected
        // payslips, not the file the month started with.
        approved: { type: Boolean, default: false },
        approved_at: { type: Date, default: null },
        approved_by_name: { type: String, default: '' },
        approved_forced: { type: Boolean, default: false },  // closed with notes still open
        summary: {
          employees:  { type: Number, default: 0 },
          notes:      { type: Number, default: 0 },
          fixed:      { type: Number, default: 0 },
          not_fixed:  { type: Number, default: 0 },
          manual:     { type: Number, default: 0 },
          unmatched:  { type: Number, default: 0 },
          new_issues: { type: Number, default: 0 },
        },
      }],
      default: [],
    },

    // ── Accountant upload link ──
    // A single-use-ish token letting the accountant push his corrected PDFs
    // straight into a new round without an account. No payroll data is exposed
    // beyond the notes we already emailed him.
    fix_token: { type: String, default: null, index: true },
    fix_token_expires: { type: Date, default: null },
    fix_token_created_at: { type: Date, default: null },
  },
  { collection: 'payslip_audits' }
);

// Helpful for "show my latest audits" sorted by date
payslipAuditSchema.index({ created_at: -1 });

module.exports = mongoose.model('PayslipAuditRecord', payslipAuditSchema);
