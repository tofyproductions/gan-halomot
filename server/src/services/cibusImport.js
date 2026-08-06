/**
 * Applying a Cibus (Pluxee) monthly report to a payroll month.
 *
 * This is the part that was buried inside the upload endpoint. It is lifted out
 * because the report now arrives two ways — a person uploading a file, and the
 * scheduled mailbox job — and those two must produce byte-identical results.
 * A second implementation for the automated path is exactly how "the automatic
 * import gave a different number" starts.
 */
const { Employee, PayrollMonth } = require('../models');
const { parseCibusReport } = require('./payslipAudit/cibusParser');

const normalizeName = (s) => (s || '')
  .replace(/[()‘’“”"'.,]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * @param {Buffer} buffer      the xlsx/csv as received
 * @param {String} filename    used only to pick the parser
 * @param {String} month       'YYYY-MM' to write into
 * @param {Object} opts.branchFilter  mongo filter limiting which employees may match
 * @param {Boolean} opts.dryRun       parse and match, write nothing
 */
async function applyCibusReport(buffer, filename, month, { branchFilter = {}, dryRun = false } = {}) {
  const report = parseCibusReport(buffer, filename);

  const allEmployees = await Employee.find({ is_active: true, ...branchFilter })
    .select('_id full_name israeli_id branch_id')
    .lean();
  const byId = new Map(allEmployees.filter(e => e.israeli_id).map(e => [e.israeli_id, e]));
  const normalized = allEmployees.map(e => ({
    emp: e, tokens: normalizeName(e.full_name).split(' ').filter(Boolean),
  }));

  const matched = [];
  const unmatched = [];
  let totalAmount = 0;

  for (const row of report.rows || []) {
    let emp = row.id ? byId.get(row.id) : null;
    if (!emp && row.name) {
      // Name matching needs two shared tokens (one for a single-word name), so
      // a shared surname alone can never charge the wrong person.
      const target = normalizeName(row.name).split(' ').filter(Boolean);
      if (target.length > 0) {
        let best = null;
        let bestScore = 0;
        for (const cand of normalized) {
          let common = 0;
          for (const t of target) if (cand.tokens.includes(t)) common++;
          const required = target.length === 1 ? 1 : 2;
          if (common >= required && common > bestScore) { best = cand.emp; bestScore = common; }
        }
        emp = best;
      }
    }
    const amount = Number(row.amount) || 0;
    totalAmount += amount;
    if (!emp) { unmatched.push({ name: row.name, id: row.id, amount }); continue; }

    if (!dryRun) {
      await PayrollMonth.findOneAndUpdate(
        { employee_id: emp._id, month },
        {
          $set: { 'manual.cibus': { kind: 'number', amount, text: '' } },
          $setOnInsert: { branch_id: emp.branch_id, employee_id: emp._id, month },
        },
        { upsert: true },
      );
    }
    matched.push({
      employee_id: String(emp._id),
      employee_name: emp.full_name,
      israeli_id: emp.israeli_id,
      amount,
    });
  }

  return {
    month,
    matched_count: matched.length,
    unmatched_count: unmatched.length,
    total_amount: Math.round(totalAmount * 100) / 100,
    matched,
    unmatched,
    detected_columns: report.detected_columns,
    warning: report.warning || null,
    dry_run: !!dryRun,
  };
}

module.exports = { applyCibusReport };
