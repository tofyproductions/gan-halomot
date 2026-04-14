const mongoose = require('mongoose');

const classroomSchema = new mongoose.Schema({
  name: { type: String, required: true },
  academic_year: { type: String, required: true },
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
  capacity: { type: Number, default: null },
  lead_teacher_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  is_active: { type: Boolean, default: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

classroomSchema.index({ name: 1, academic_year: 1, branch_id: 1 }, { unique: true });

module.exports = mongoose.model('Classroom', classroomSchema);
