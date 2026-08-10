/**
 * Archive the per-employee payslips of a distribution that already went out.
 *
 * Sending payslips to branch managers used to mail a merged branch PDF and
 * store nothing, so "תלושי עובדים" showed every employee as having none even
 * right after a successful send. The send path archives per employee now; this
 * fills in the sends that happened before it did, without mailing anything.
 *
 * `delivered_to_employee` stays FALSE. The employee received nothing — only
 * her manager did — and "התלושים שלי" must go on saying so.
 *
 *   node scripts/backfill-manager-payslips.js                 # report
 *   node scripts/backfill-manager-payslips.js --write         # apply
 *   node scripts/backfill-manager-payslips.js --month 2026-07 # one month
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { PDFDocument } = require('pdf-lib');
const { PayslipAuditRecord, PayslipAuditPdf, Employee, SavedPayslip } = require('../src/models');

const WRITE = process.argv.includes('--write');
const monthArg = (() => {
  const i = process.argv.indexOf('--month');
  return i > -1 ? process.argv[i + 1] : null;
})();

const norm = s => String(s || '').replace(/\s+/g, ' ').trim();

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);

  // The audit a manager send would have used: the most recently approved one
  // for each month. An unapproved audit is a draft — its pages are not what
  // anybody was sent.
  const audits = await PayslipAuditRecord.find(
    monthArg ? { year_month: monthArg } : {},
  ).sort({ created_at: -1 }).lean();

  const byMonth = new Map();
  for (const a of audits) {
    if (!a.approved) continue;
    if (!byMonth.has(a.year_month)) byMonth.set(a.year_month, a);
  }

  if (byMonth.size === 0) {
    console.log('No approved audits found — nothing to archive.');
    console.log(`(${audits.length} audits exist; an unapproved audit is a draft and is skipped.)`);
    await mongoose.disconnect();
    return;
  }

  let written = 0;
  let skipped = 0;

  for (const [month, audit] of byMonth) {
    const results = audit.full_result?.results || [];
    console.log(`\n${month} — audit ${audit._id}, ${results.length} rows`);

    // The stored PDFs for this audit, keyed by the branch file they came from.
    // 'approved' beats 'original', the same order loadBranchPdf uses when the
    // distribution builds a bundle — otherwise this archives the pre-correction
    // payslip that nobody was sent.
    const pdfs = await PayslipAuditPdf.find({ audit_id: audit._id }).lean();
    const pdfBySource = new Map();
    for (const kind of ['original', 'approved']) {
      for (const p of pdfs.filter(x => x.kind === kind)) {
        const bytes = p.data?.buffer ? Buffer.from(p.data.buffer) : (p.data ? Buffer.from(p.data) : null);
        if (bytes) pdfBySource.set(norm(p.branch), bytes);
      }
    }
    if (pdfBySource.size === 0) { console.log('  no stored PDFs — skipped'); continue; }

    for (const r of results) {
      const page = r.payslip?.page_index || null;
      if (!page) { skipped += 1; continue; }
      const iid = String(r.payslip?.employee_id || r.table_row?.israeli_id || '').trim();
      if (!iid) { skipped += 1; continue; }

      const emp = await Employee.findOne({ israeli_id: iid }).select('_id full_name branch_id').lean();
      if (!emp) { skipped += 1; continue; }

      const source = norm(r.__source_branch || r.table_row?.branch || '');
      const bytes = pdfBySource.get(source) || [...pdfBySource.values()][0];
      if (!bytes) { skipped += 1; continue; }

      // An existing row already holds this month — leave it exactly as it is,
      // especially delivered_to_employee.
      const existing = await SavedPayslip.findOne({ employee_id: emp._id, year_month: month }).lean();
      if (existing) { skipped += 1; continue; }

      console.log(`  ${emp.full_name} — page ${page}`);
      if (!WRITE) { written += 1; continue; }

      try {
        const src = await PDFDocument.load(bytes);
        if (page < 1 || page > src.getPageCount()) { skipped += 1; continue; }
        const one = await PDFDocument.create();
        (await one.copyPages(src, [page - 1])).forEach(pg => one.addPage(pg));
        await SavedPayslip.create({
          employee_id: emp._id,
          israeli_id: iid,
          year_month: month,
          branch: source,
          data: Buffer.from(await one.save()),
          audit_id: audit._id,
          page,
          delivered_to_employee: false,
        });
        written += 1;
      } catch (e) {
        console.error('  failed:', emp.full_name, e.message);
        skipped += 1;
      }
    }
  }

  console.log(`\n${written} payslips ${WRITE ? 'archived' : 'would be archived'}, ${skipped} skipped.`);
  if (!WRITE) console.log('Dry run — pass --write to apply.');

  await mongoose.disconnect();
})().catch((err) => { console.error(err); process.exit(1); });
