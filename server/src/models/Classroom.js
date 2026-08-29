const mongoose = require('mongoose');

const CLASSROOM_CATEGORIES = ['תינוקייה', 'צעירים', 'בוגרים'];

const classroomSchema = new mongoose.Schema({
  name: { type: String, required: true },
  category: { type: String, enum: CLASSROOM_CATEGORIES, default: null },
  academic_year: { type: String, required: true },
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
  capacity: { type: Number, default: null },
  /**
   * The room's lead, twice, because they answer different questions.
   *
   * `lead_employee_id` is who is RESPONSIBLE for the children — a staff card,
   * which is what almost every גננת actually is. This is the one the contact
   * sheet prints and the one a parent is told about.
   *
   * `lead_teacher_id` is a LOGIN, and it exists because the class-tracking
   * screen grants "the lead may answer for her own room" off it. Kept rather
   * than migrated: it is a live permission, most staff have no login to move
   * it to, and the two can disagree without either being wrong — the person
   * responsible for the room and the person who signs in to report on it are
   * not always the same person.
   */
  lead_employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
  lead_teacher_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  /**
   * Who may write this room's monthly work plan, besides a manager.
   *
   * A list rather than one person because a room is usually run by two, and
   * both of them plan. `lead_teacher_id` still counts — it is a live
   * permission on rooms that have one, and making every gan re-enter it to
   * keep working would be a migration disguised as a feature.
   */
  gantt_editor_ids: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  is_active: { type: Boolean, default: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

classroomSchema.statics.CATEGORIES = CLASSROOM_CATEGORIES;

classroomSchema.index({ name: 1, academic_year: 1, branch_id: 1 }, { unique: true });

module.exports = mongoose.model('Classroom', classroomSchema);
