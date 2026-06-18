const mongoose = require('mongoose');

const documentSchema = new mongoose.Schema({
  registration_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Registration', required: true },
  child_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Child', default: null },
  doc_type: { type: String, default: 'general' },
  file_name: { type: String, required: true },
  // R2 key for files we host. Empty for externally-hosted docs (see external_url).
  file_path: { type: String, default: '' },
  // For documents that live outside R2 — e.g. Google Drive files carried over
  // from the old system. download() redirects here instead of an R2 presigned URL.
  external_url: { type: String, default: null },
  mime_type: { type: String, default: null },
  file_size_bytes: { type: Number, default: 0 },
  uploaded_at: { type: Date, default: Date.now },
});

documentSchema.index({ registration_id: 1 });

module.exports = mongoose.model('Document', documentSchema);
