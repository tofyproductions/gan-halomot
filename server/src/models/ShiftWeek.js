const mongoose = require('mongoose');

/**
 * One branch's rota for one week (Sunday–Friday).
 *
 * Two copies of the same list, on purpose. `entries` is what the manager is
 * editing; `published` is what the staff were told at the last "סגירת סידור".
 * Employees only ever read `published`, so a half-finished edit is never a
 * schedule somebody acts on, and the diff between the two is exactly the set
 * of people a re-publish has to notify.
 */
const entrySchema = new mongoose.Schema({
  employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  // Snapshot: the printed rota must still read right after a rename or a departure.
  employee_name: { type: String, default: '' },
  date: { type: String, required: true }, // YYYY-MM-DD
  area: { type: String, enum: ['class', 'kitchen', 'floater', 'unassigned'], required: true },
  classroom_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Classroom', default: null },
  start_hhmm: { type: String, default: '' },
  end_hhmm: { type: String, default: '' },
  // The commitment's alternating day off, seeded as working; the manager decides per week.
  alternating: { type: Boolean, default: false },
  // Placed in a class that was not hers before this week — shown to the manager.
  new_class: { type: Boolean, default: false },
});

const shiftWeekSchema = new mongoose.Schema({
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  week_start: { type: String, required: true }, // a Sunday
  entries: { type: [entrySchema], default: [] },
  published: { type: [entrySchema], default: [] },
  published_at: { type: Date, default: null },
  published_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  // Days the manager closed for this week only, beyond the gan's own calendar.
  closed_days: { type: [String], default: [] },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

shiftWeekSchema.index({ branch_id: 1, week_start: 1 }, { unique: true });

module.exports = mongoose.model('ShiftWeek', shiftWeekSchema);
