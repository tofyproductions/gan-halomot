const mongoose = require('mongoose');

/**
 * Durable storage for the payslip PDFs uploaded with an audit run. The local
 * filesystem on the hosting tier is EPHEMERAL (wiped on every deploy / sleep /
 * restart), which made saved payslips disappear — the audit record survived in
 * Mongo but the PDF files on disk were gone. Storing the PDF bytes in Mongo
 * keeps them available for the per-page preview after restarts.
 *
 * A handful of PDFs per audit (≤10 branches, ~250KB each) sits well under the
 * 16MB document cap since each branch PDF is its own document.
 */
const payslipAuditPdfSchema = new mongoose.Schema({
  audit_id: { type: mongoose.Schema.Types.ObjectId, ref: 'PayslipAuditRecord', required: true, index: true },
  branch: { type: String, required: true },
  kind: { type: String, enum: ['original', 'approved'], default: 'original' },
  data: { type: Buffer, required: true },
}, { timestamps: true });

payslipAuditPdfSchema.index({ audit_id: 1, branch: 1, kind: 1 }, { unique: true });

module.exports = mongoose.model('PayslipAuditPdf', payslipAuditPdfSchema);
