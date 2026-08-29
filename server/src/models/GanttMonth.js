const mongoose = require('mongoose');

const ganttCellSchema = new mongoose.Schema({
  row_key: { type: String, required: true },
  day_index: { type: Number, required: true, min: 0, max: 5 },
  content: { type: String, default: '' },
  color: { type: String, default: '' },
  col_span: { type: Number, default: 1 },
  row_span: { type: Number, default: 1 },
}, { _id: false });

const ganttWeekSchema = new mongoose.Schema({
  week_number: { type: Number, required: true },
  start_date: { type: Date, required: true },
  end_date: { type: Date, required: true },
  topic: { type: String, default: '' },
  cells: [ganttCellSchema],
  // The names are what the plan prints and what the gan has always written.
  friday_parent_father: { type: String, default: '' },
  friday_parent_mother: { type: String, default: '' },
  // The children they refer to, so a turn can be counted. Kept beside the
  // names rather than replacing them: years of plans hold names and no ids,
  // and a name typed by hand is still a valid thing to write here.
  friday_father_child_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Child', default: null },
  friday_mother_child_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Child', default: null },
}, { _id: true });

const ganttMonthSchema = new mongoose.Schema({
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  classroom_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Classroom', required: true },
  academic_year: { type: String, required: true },
  month: { type: Number, required: true, min: 1, max: 12 },
  year: { type: Number, required: true },
  status: {
    type: String,
    enum: ['draft', 'pending', 'approved'],
    default: 'draft',
  },
  row_definitions: [{
    key: { type: String, required: true },
    label: { type: String, required: true },
  }],
  weeks: [ganttWeekSchema],
  approved_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  approved_at: { type: Date, default: null },

  /**
   * Who saved last. Two gananot plan the same room, and until now a save
   * replaced the whole month with whatever the saver's screen was holding —
   * so the one who pressed שמור second silently deleted the other's morning.
   * Recorded so the screen can say whose work it is looking at, and so a save
   * that would land on top of somebody else's can be refused.
   */
  updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

ganttMonthSchema.index({ branch_id: 1, classroom_id: 1, month: 1, year: 1 }, { unique: true });

module.exports = mongoose.model('GanttMonth', ganttMonthSchema);
