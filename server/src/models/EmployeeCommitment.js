const mongoose = require('mongoose');

/**
 * EmployeeCommitment = the contracted weekly schedule for an employee.
 * Drives "did she show up on her commitment days?" checks in attendance,
 * and also explains why a given day is blank (it was her day off).
 *
 * The Israeli work-week: Sunday(0) through Friday(5).
 */
const dayCommitmentSchema = new mongoose.Schema({
  day: { type: Number, min: 0, max: 5, required: true }, // 0=Sun, 5=Fri
  is_off: { type: Boolean, default: false },             // explicit day off
  start_hhmm: { type: String, default: '' },             // "07:00"
  end_hhmm: { type: String, default: '' },               // "16:00"
}, { _id: false });

const employeeCommitmentSchema = new mongoose.Schema({
  employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, unique: true, index: true },
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  classroom: { type: String, default: '' },              // תינוקייה / צעירים / בוגרים / מטבח / מחליפה
  days: { type: [dayCommitmentSchema], default: [] },
  // "חופש לסרוגין" — alternating-week day off. We carry it as a separate
  // flag so the integrator can decide which weeks the day counts.
  is_alternating_off: { type: Boolean, default: false },
  alternating_day: { type: Number, default: null },      // 0..5 — the day that alternates
  // How many times PER MONTH the alternating day is actually worked (e.g. one
  // Friday a month = 1, every other week ≈ 2). null → legacy "every other week"
  // (counted at half time per occurrence). The monthly committed hours for that
  // day = alternating_per_month × the day's hours, and the day is never flagged
  // as an absence (we can't know which specific occurrence she works).
  alternating_per_month: { type: Number, default: null }, // 1 | 2 | 3 | 4
  notes: { type: String, default: '' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

employeeCommitmentSchema.index({ branch_id: 1 });

module.exports = mongoose.model('EmployeeCommitment', employeeCommitmentSchema);
