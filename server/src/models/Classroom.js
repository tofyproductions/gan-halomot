const mongoose = require('mongoose');

const classroomSchema = new mongoose.Schema({
  name: { type: String, required: true },
  academic_year: { type: String, required: true },
  capacity: { type: Number, default: null },
  is_active: { type: Boolean, default: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

classroomSchema.index({ name: 1, academic_year: 1 }, { unique: true });

module.exports = mongoose.model('Classroom', classroomSchema);
