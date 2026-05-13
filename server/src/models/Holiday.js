const mongoose = require('mongoose');

const holidaySchema = new mongoose.Schema({
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  academic_year: { type: String, required: true },
  name: { type: String, required: true },
  start_date: { type: Date, required: true },
  end_date: { type: Date, required: true },
  is_custom: { type: Boolean, default: false },
  // Half-day support — when `is_half_day` is true the LAST day of the range
  // is short (employees work until `end_time`, default 12:00). Single-day
  // holidays use end_time on that one day. Used by attendance / reports.
  is_half_day: { type: Boolean, default: false },
  end_time: { type: String, default: '' }, // "HH:MM" — only meaningful when is_half_day
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

holidaySchema.index({ branch_id: 1, academic_year: 1 });

module.exports = mongoose.model('Holiday', holidaySchema);
