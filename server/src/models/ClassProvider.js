const mongoose = require('mongoose');

/**
 * ClassProvider — an external activity/class provider for the kindergartens
 * (יוגה, תנועה, חוג חיות, מוסיקה …). Distinct from the food/order Supplier
 * model: these are free-standing service providers referenced by ClassProgram.
 * Instructors are free-text names on the program, but the provider (the person
 * or business the money goes to) is a registered entity here.
 */
const classProviderSchema = new mongoose.Schema({
  name: { type: String, required: true },       // e.g. "טל — יוגה" / business name
  field: { type: String, default: '' },         // תחום: תנועה / מוסיקה / חיות …
  phone: { type: String, default: '' },
  email: { type: String, default: '' },
  notes: { type: String, default: '' },

  /**
   * The branches this provider works at.
   *
   * Derivable from their programs, and kept here anyway, because it is the
   * thing a person answers FIRST when setting one up — "where does she come?"
   * — and the days, times and rates hang off that answer. Without it the setup
   * screen has nothing to lay out and the branch has to be re-chosen on every
   * row.
   *
   * It is the setup's shape, not a permission: nothing reads it to decide what
   * anybody may see. A program whose branch is not in this list still works.
   */
  branch_ids: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Branch' }],

  /**
   * Whether this provider's rates carry VAT.
   *
   * 'exempt'     עוסק פטור — the rate IS the invoice. Most of the instructors.
   * 'registered' עוסק מורשה — the rate is before VAT and the invoice adds it.
   *
   * Stored per provider rather than system-wide because the gan pays both
   * kinds, and the old spreadsheet proved what happens otherwise: one cell in
   * it reads "3398.40 כולל מעמ" in a column of numbers that are not, which is
   * a sum nobody can check a month later.
   *
   * The RATE ON A PROGRAM IS ALWAYS THE PRE-VAT FIGURE. For an exempt provider
   * the two are the same number; for a registered one the summary adds the VAT
   * on top. That way the rate means one thing everywhere.
   */
  vat_mode: { type: String, enum: ['exempt', 'registered'], default: 'exempt' },
  is_active: { type: Boolean, default: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

module.exports = mongoose.model('ClassProvider', classProviderSchema);
