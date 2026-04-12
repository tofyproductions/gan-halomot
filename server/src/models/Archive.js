const mongoose = require('mongoose');

const archiveSchema = new mongoose.Schema({
  registration_id: { type: mongoose.Schema.Types.ObjectId, default: null },
  archive_type: { type: String, enum: ['signed', 'unsigned'], required: true },
  original_data: { type: mongoose.Schema.Types.Mixed, required: true },
  child_name: { type: String, required: true },
  classroom_name: { type: String, default: null },
  academic_year: { type: String, default: '' },
  archived_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  archived_at: { type: Date, default: Date.now },
  restored_at: { type: Date, default: null },
  restored_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: false });

module.exports = mongoose.model('Archive', archiveSchema);
