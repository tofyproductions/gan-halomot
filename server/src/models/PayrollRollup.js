const mongoose = require('mongoose');

/**
 * One month of one branch's payroll, reduced to the four numbers somebody
 * above that branch actually asks for.
 *
 * WHY THIS EXISTS. The payroll screen loads every employee in scope and works
 * out each one's pay in Node — correct, and about 1.8ms per employee. At four
 * branches that is instant. Measured at 400 it is thirty seconds, and it grows
 * faster than the data does, so a network of two thousand branches never gets a
 * screen at all.
 *
 * But the person waiting on that screen is a network director, and a network
 * director is not reading one carer's punches. They want to know what the
 * מחוז costs this month. So the expensive thing is not made faster — it stops
 * being asked for. A branch is computed once, at branch size, where it already
 * measures flat at about 100ms whatever the network's size; the district is the
 * sum of its branches, and the network is the sum of its districts. The cost of
 * the director's screen follows how many units report to them — twenty, not
 * eighty thousand.
 *
 * THE NUMBERS ARE NOT RECOMPUTED HERE, and that is the point. They are written
 * by the branch screen as it renders, from the totals it has already worked
 * out, so a district can never disagree with the branches under it. A second
 * implementation of Israeli payroll maths, kept in step with the first by
 * hand, is a wrong number waiting for the month somebody edits only one of them.
 *
 * `computed_at` is therefore load-bearing and belongs on screen: these are the
 * figures as of the last time each branch was opened or warmed, not as of now.
 */
const payrollRollupSchema = new mongoose.Schema({
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  month: { type: String, required: true },     // 'YYYY-MM'

  employees: { type: Number, default: 0 },
  hours: { type: Number, default: 0 },
  base: { type: Number, default: 0 },          // שכר בסיס — the same field the branch strip shows

  computed_at: { type: Date, default: Date.now },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

payrollRollupSchema.index({ month: 1, branch_id: 1 }, { unique: true });
payrollRollupSchema.index({ branch_id: 1 });

module.exports = mongoose.models.PayrollRollup
  || mongoose.model('PayrollRollup', payrollRollupSchema);
