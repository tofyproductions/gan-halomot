const mongoose = require('mongoose');

const CATEGORIES = ['מזגן', 'מקרר', 'רמקול', 'מכשיר', 'מלאי', 'אחר'];

/**
 * A fault report against a maintenance item — a free-text description plus an
 * optional photo (base64 in Mongo, matching the app's other file storage).
 */
const faultSchema = new mongoose.Schema({
  description: { type: String, required: true },
  photo_data: { type: String, default: null },   // base64
  photo_name: { type: String, default: '' },
  status: { type: String, enum: ['open', 'resolved'], default: 'open' },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  resolved_at: { type: Date, default: null },
  resolved_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

/**
 * MaintenanceItem — one physical asset to maintain at a branch (an air
 * conditioner in a classroom, a fridge, a speaker, a device, a stock item…).
 * Common service fields (model, location, last service, cleaning cycle) plus a
 * flexible `specs` map for per-category parameters, and a list of fault reports.
 */
const maintenanceItemSchema = new mongoose.Schema({
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  category: { type: String, enum: CATEGORIES, required: true },
  name: { type: String, required: true },
  model: { type: String, default: '' },               // דגם
  location: { type: String, default: '' },            // כיתה / חדר
  quantity: { type: Number, default: 1 },
  last_service_at: { type: Date, default: null },      // מתי בוצע ניקוי/טיפול אחרון
  service_cycle_days: { type: Number, default: null }, // כל כמה זמן לתחזק (ימים)
  specs: { type: mongoose.Schema.Types.Mixed, default: {} }, // per-category free params
  faults: { type: [faultSchema], default: [] },
  notes: { type: String, default: '' },
  is_active: { type: Boolean, default: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

maintenanceItemSchema.index({ branch_id: 1, category: 1, is_active: 1 });

module.exports = mongoose.model('MaintenanceItem', maintenanceItemSchema);
module.exports.CATEGORIES = CATEGORIES;
