const mongoose = require('mongoose');

/**
 * ClassProvider — an external activity/class provider for the kindergartens
 * (יוגה, תנועה, חוג חיות, מוסיקה …). Distinct from the food/order Supplier
 * model: these are free-standing service providers referenced by ClassProgram.
 * Instructors are free-text names on the program, but the provider (the person
 * or business the money goes to) is a registered entity here.
 */
const classProviderSchema = new mongoose.Schema({
  name: { type: String, required: true },       // e.g. "טל — יוגה" / business name
  field: { type: String, default: '' },         // תחום: תנועה / מוסיקה / חיות …
  phone: { type: String, default: '' },
  email: { type: String, default: '' },
  notes: { type: String, default: '' },
  is_active: { type: Boolean, default: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

module.exports = mongoose.model('ClassProvider', classProviderSchema);
