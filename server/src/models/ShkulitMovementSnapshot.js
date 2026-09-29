const mongoose = require('mongoose');

/**
 * Which component codes we last FILED for an employee — so that next month we
 * can switch off the ones that no longer apply.
 *
 * שקלולית carries a payslip forward. A component that was on last month's
 * payslip and is absent from this month's file is not dropped: it is kept at
 * last month's value and PAID AGAIN. The accountant is expected to go down the
 * previous payslip line by line and zero what no longer belongs — for seventy
 * employees, every month, by hand.
 *
 * That is how הבראה, which is paid once a year in August, sits in September's
 * payslip at its August value waiting for somebody to notice; and how a month's
 * 150% overtime keeps being paid to an employee who worked none.
 *
 * So we remember what we sent. Next month, any code that was in the file and is
 * not in it now goes out again with a quantity and rate of ZERO, which is what
 * switches it off. A row nobody has to remember is a row nobody forgets.
 *
 * ── Per month, not "the latest" ──
 *
 * `history` keeps each month's set separately; only the month directly before
 * the one being filed is used (services/payrollExport/movementHistory.js).
 * Keeping just the latest file meant that downloading September once made
 * September its own "previous month", and August's leftovers were never zeroed.
 * `components` / `month` still hold the newest entry for older readers.
 *
 * ── What it covers ──
 *
 * What we filed, plus the confirmed codes the accountant keys by hand from our
 * notes (הבראה, code 4), which sit on the payslip just the same. Codes we do
 * not manage are never here: zeroing one could wipe a line she entered on
 * purpose.
 */
const shkulitMovementSnapshotSchema = new mongoose.Schema({
  employee_number: { type: String, required: true, unique: true, index: true },
  /**
   * The codes in the last file, each with the code table it came from — the
   * zero row has to name the same טבלה or it addresses a different component.
   */
  components: {
    type: [{
      code: { type: Number, required: true },
      table: { type: Number, default: 1 },
      _id: false,
    }],
    default: [],
  },
  /** 'YYYY-MM' of that file, so a re-export of an older month cannot mislead. */
  month: { type: String, default: null },
  history: {
    type: [{
      month: { type: String, required: true },
      components: {
        type: [{
          code: { type: Number, required: true },
          table: { type: Number, default: 1 },
          _id: false,
        }],
        default: [],
      },
      _id: false,
    }],
    default: [],
  },
  last_exported_at: { type: Date, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

module.exports = mongoose.model('ShkulitMovementSnapshot', shkulitMovementSnapshotSchema);
