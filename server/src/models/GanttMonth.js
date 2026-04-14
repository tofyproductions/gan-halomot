const mongoose = require('mongoose');

const ganttCellSchema = new mongoose.Schema({
  row_key: { type: String, required: true },
  day_index: { type: Number, required: true, min: 0, max: 5 },
  content: { type: String, default: '' },
  color: { type: String, default: '' },
  merge_span: { type: Number, default: 0 },
}, { _id: false });

const ganttWeekSchema = new mongoose.Schema({
  week_number: { type: Number, required: true },
  start_date: { type: Date, required: true },
  end_date: { type: Date, required: true },
  topic: { type: String, default: '' },
  cells: [ganttCellSchema],
  friday_parent_father: { type: String, default: '' },
  friday_parent_mother: { type: String, default: '' },
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
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

ganttMonthSchema.index({ branch_id: 1, classroom_id: 1, month: 1, year: 1 }, { unique: true });

module.exports = mongoose.model('GanttMonth', ganttMonthSchema);
