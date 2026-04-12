const mongoose = require('mongoose');

const documentSchema = new mongoose.Schema({
  registration_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Registration', required: true },
  child_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Child', default: null },
  doc_type: { type: String, default: 'general' },
  file_name: { type: String, required: true },
  file_path: { type: String, required: true },
  mime_type: { type: String, default: null },
  file_size_bytes: { type: Number, default: 0 },
  uploaded_at: { type: Date, default: Date.now },
});

documentSchema.index({ registration_id: 1 });

module.exports = mongoose.model('Document', documentSchema);
