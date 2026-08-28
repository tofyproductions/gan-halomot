const mongoose = require('mongoose');

/**
 * A gan's OWN addition to the content bank.
 *
 * The bank ships with the system: six years of the gan's real yearly work
 * plans, extracted from the workbooks and kept in
 * server/src/content-bank/seed.json. That part is the same for every
 * customer and is not in any database — it is content we supply, it is read
 * far more than a hundred times a day, and a customer must never be able to
 * edit or delete it out from under the next one.
 *
 * This model is only the layer ABOVE it: what this particular gan wrote
 * itself, and which of the shipped items it has hidden because it does not
 * work for them. Merging the two is contentBank.service's job.
 */
const contentBankItemSchema = new mongoose.Schema({
  // The weekly subject a gananet searches by — "פסח", "הגינה", "אני וגופי".
  theme: { type: String, required: true, trim: true },

  // Which gantt row this belongs in. Same keys as GanttMonth.row_definitions,
  // so an item can be dropped straight into the matching row.
  category: {
    type: String,
    required: true,
    enum: ['meeting', 'activity', 'creation', 'story', 'misc'],
  },

  title: { type: String, required: true, trim: true },
  notes: { type: String, default: '' },

  // What has to be on the table to run it. The reason this is stored at all:
  // a gan that does not own the materials needs to know before the week
  // starts, not on the morning of — and it is what we can then supply.
  materials: [{ type: String, trim: true }],

  // תינוקייה / צעירים / בוגרים. Empty = suits any age.
  age_groups: [{ type: String }],

  // Set when the gan has hidden a SHIPPED item rather than written a new one.
  // Holds the seed item's id; `title` is kept for the audit trail only.
  hides_seed_id: { type: String, default: null, index: true },

  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

contentBankItemSchema.index({ theme: 1, category: 1 });

module.exports = mongoose.model('ContentBankItem', contentBankItemSchema);
