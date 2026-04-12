const mongoose = require('mongoose');

const collectionHistorySchema = new mongoose.Schema({
  child_name: { type: String, required: true },
  academic_year: { type: String, required: true },
  collection_data: { type: mongoose.Schema.Types.Mixed, required: true },
  archived_at: { type: Date, default: Date.now },
});

module.exports = mongoose.model('CollectionHistory', collectionHistorySchema);
