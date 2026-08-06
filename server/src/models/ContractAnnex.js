const mongoose = require('mongoose');

/**
 * A standing annex to the employment contract — currently נספח ג' "ונשמרתם",
 * the safety manual, which arrives as four scanned PDFs of ~30 pages each.
 *
 * It is stored ONCE and referenced by every contract, rather than inlined into
 * each contract's HTML: it is 113 scanned pages that are identical for every
 * employee, it changes only when the manual is reissued, and pasting it into
 * every generated PDF would make each contract unopenable on a phone — which
 * is exactly where the employee is meant to read and sign it.
 *
 * The employee is shown the parts on the signing page and must confirm she
 * opened them before she can sign, so "מצורף כנספח" is a real attachment she
 * saw rather than a line of text she scrolled past.
 */
const contractAnnexSchema = new mongoose.Schema({
  // Which annex this belongs to. Only 'c' today; the field exists so adding
  // another standing annex later doesn't need a migration.
  annex_key: { type: String, default: 'c', index: true },
  title: { type: String, default: 'נספח ג׳ — ונשמרתם' },

  part: { type: Number, default: 1 },       // ordering within the annex
  file_name: { type: String, required: true },
  mime_type: { type: String, default: 'application/pdf' },
  size_bytes: { type: Number, default: 0 },
  page_count: { type: Number, default: 0 },
  file_data: { type: String, required: true },  // base64, no data: prefix

  is_active: { type: Boolean, default: true },
  uploaded_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  uploaded_by_name: { type: String, default: '' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

contractAnnexSchema.index({ annex_key: 1, part: 1 });

module.exports = mongoose.model('ContractAnnex', contractAnnexSchema);
