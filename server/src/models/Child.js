const mongoose = require('mongoose');

const childSchema = new mongoose.Schema({
  registration_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Registration', required: true },
  child_name: { type: String, required: true },
  birth_date: { type: Date, default: null },
  classroom_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Classroom', default: null },
  parent_name: { type: String, default: '' },
  phone: { type: String, default: null },
  email: { type: String, default: null },
  medical_alerts: { type: String, default: null },
  academic_year: { type: String, required: true },
  is_active: { type: Boolean, default: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

childSchema.index({ registration_id: 1 });
childSchema.index({ classroom_id: 1, academic_year: 1 });

module.exports = mongoose.model('Child', childSchema);
