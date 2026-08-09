const mongoose = require('mongoose');

const documentSchema = new mongoose.Schema({
  registration_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Registration', required: true },
  child_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Child', default: null },
  doc_type: { type: String, default: 'general' },
  file_name: { type: String, required: true },
  // Legacy object-storage key. No document has ever used one — object storage
  // was configured but never wired up, so every upload through it was silently
  // discarded. Kept only so old rows still parse.
  file_path: { type: String, default: '' },
  // The file itself, base64, alongside Contract.file_data and
  // EmployeeDocument.file_data which have always worked this way.
  file_data: { type: String, default: null },
  // For documents that live outside R2 — e.g. Google Drive files carried over
  // from the old system. download() redirects here instead of an R2 presigned URL.
  external_url: { type: String, default: null },
  mime_type: { type: String, default: null },
  file_size_bytes: { type: Number, default: 0 },
  uploaded_at: { type: Date, default: Date.now },
});

documentSchema.index({ registration_id: 1 });

module.exports = mongoose.model('Document', documentSchema);
