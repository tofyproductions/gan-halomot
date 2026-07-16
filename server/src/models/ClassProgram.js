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
  // Which classroom category this class serves (matches Classroom.category).
  classroom_category: { type: String, default: '' },      // תינוקייה / צעירים / בוגרים / קבוצה
  classroom_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Classroom', default: null },
  default_rate: { type: Number, default: 0 },             // ₪ per session (session may override)
  default_day: { type: Number, default: null, min: 0, max: 5 }, // 0=Sun..5=Fri, null=flexible
  default_time: { type: String, default: '' },            // "HH:mm" (session may override)
  color: { type: String, default: '#fce7f3' },            // gantt cell tint
  is_active: { type: Boolean, default: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

classProgramSchema.index({ branch_id: 1, is_active: 1 });

module.exports = mongoose.model('ClassProgram', classProgramSchema);
