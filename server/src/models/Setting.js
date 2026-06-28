const mongoose = require('mongoose');

/** Tiny key/value store for app-wide settings (e.g. accountant_email). */
const settingSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, index: true },
  value: { type: mongoose.Schema.Types.Mixed, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

module.exports = mongoose.model('Setting', settingSchema);
