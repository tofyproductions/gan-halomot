const mongoose = require('mongoose');

/**
 * ClassProgram — a recurring class (חוג) at a branch for a classroom category,
 * run by a ClassProvider. Holds the defaults that new sessions inherit: the
 * fixed weekday + time and the per-session rate (each of which a session may
 * override individually). Sessions (ClassSession) are the actual dated meetings.
 *
 * Kept separate from the Gantt's `Activity` "בנק חוגים" so this tracking flow
 * doesn't disturb the existing drag-drop gantt authoring; sessions are mirrored
 * onto the gantt read-side.
 */
const classProgramSchema = new mongoose.Schema({
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  provider_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ClassProvider', default: null },
  name: { type: String, required: true },                 // e.g. "יוגה", "תנועה"
  instructor_name: { type: String, default: '' },         // free-text (may differ from provider)
  /**
   * Which classroom groups this class serves.
   *
   * USUALLY ONE, SOMETIMES SEVERAL — and several means one meeting, not
   * several. An instructor who sits the תינוקייה and the צעירים together at
   * 09:00 is running a single lesson for two groups and is paid once for it;
   * two groups she takes one after the other are two rows, two times and two
   * rates. The difference is the hour, and it is the whole reason this is a
   * list rather than a second row.
   *
   * `classroom_category` is kept as the FIRST of them. Every existing row,
   * query and screen reads that field, and a migration that rewrites them all
   * to satisfy a new shape is a migration that breaks one of them quietly.
   * The controllers keep the two in step on every write.
   */
  classroom_categories: { type: [String], default: [] },
  classroom_category: { type: String, default: '' },      // = classroom_categories[0]
  classroom_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Classroom', default: null },
  default_rate: { type: Number, default: 0 },             // ₪ per session (session may override)
  default_day: { type: Number, default: null, min: 0, max: 5 }, // 0=Sun..5=Fri, null=flexible
  default_time: { type: String, default: '' },            // "HH:mm" (session may override)
  color: { type: String, default: '#fce7f3' },            // gantt cell tint
  is_active: { type: Boolean, default: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

classProgramSchema.index({ branch_id: 1, is_active: 1 });

module.exports = mongoose.model('ClassProgram', classProgramSchema);
