const mongoose = require('mongoose');

/**
 * Amuta = Legal entity that pays salaries.
 * An employee may be paid partially from multiple amutot (see Employee.amuta_distribution).
 *
 * From CSV: 3 amutot — "אמונה - כפר סבא", "אמונה - הרצליה", "מאזן כללי".
 */
const amutaSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  short_name: { type: String, default: '' },           // internal key, e.g. "emuna_ks"
  tax_id: { type: String, default: '' },               // ח"פ / ע"מ
  branches: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Branch' }],
  is_active: { type: Boolean, default: true },
  notes: { type: String, default: '' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

module.exports = mongoose.model('Amuta', amutaSchema);
