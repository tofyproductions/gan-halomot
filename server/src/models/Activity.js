const mongoose = require('mongoose');

const activitySchema = new mongoose.Schema({
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  name: { type: String, required: true },
  color: { type: String, default: '#dbeafe' },
  fixed_day: { type: Number, default: null, min: 0, max: 5 }, // null=flexible, 0=Sun..5=Fri
  target_row: { type: String, default: 'misc' }, // which gantt row it goes to
  is_active: { type: Boolean, default: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

activitySchema.index({ branch_id: 1 });

module.exports = mongoose.model('Activity', activitySchema);
