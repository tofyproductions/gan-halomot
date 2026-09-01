const mongoose = require('mongoose');

/**
 * "רשימת ציוד להורים" — the equipment list sent to parents as a poster image.
 *
 * One document, global (no branch_id): the supplies a kindergarten asks for
 * (diapers, sheets, a change of clothes) don't vary by branch in practice, and
 * a singleton keeps the editor simple — there is exactly one list to open and
 * edit, the same one every branch's office reuses when they need a fresh poster.
 */
const supplyItemSchema = new mongoose.Schema({
  name: { type: String, required: true },
  note: { type: String, default: '' },
  emoji: { type: String, default: '' },
  color: { type: String, default: '' },
}, { _id: true });

const supplyListSchema = new mongoose.Schema({
  title: { type: String, default: 'רשימת ציוד' },
  subtitle: { type: String, default: 'גן החלומות' },
  lead: { type: String, default: '' },
  callout: { type: String, default: 'יש לציין שם על כל הפריטים' },
  footer: { type: String, default: 'שנת לימודים פורייה ומוצלחת! — מאחל צוות גן החלומות' },
  items: { type: [supplyItemSchema], default: [] },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

module.exports = mongoose.model('SupplyList', supplyListSchema);
