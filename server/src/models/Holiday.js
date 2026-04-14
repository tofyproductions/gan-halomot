const mongoose = require('mongoose');

const holidaySchema = new mongoose.Schema({
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  academic_year: { type: String, required: true },
  name: { type: String, required: true },
  start_date: { type: Date, required: true },
  end_date: { type: Date, required: true },
  is_custom: { type: Boolean, default: false },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

holidaySchema.index({ branch_id: 1, academic_year: 1 });

module.exports = mongoose.model('Holiday', holidaySchema);
