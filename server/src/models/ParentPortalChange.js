const mongoose = require('mongoose');

/**
 * Every change a parent makes, written down before it is applied.
 *
 * The gan's rule for the portal is that a parent may correct their own
 * details without waiting for anyone, and that the staff must know it
 * happened. Those two only hold together if the knowing is a record rather
 * than a hope: an edit that lands silently in the database is indistinguishable
 * from one that never happened, and the field this matters most for is the one
 * nobody can afford to be wrong about.
 *
 * So every edit lands here first, with what the value was and what it became.
 * `before` is the point — "מיכל changed the allergies" is not actionable, and
 * "אגוזים → (ריק)" is.
 *
 * Severity is set by the field, not by the parent. Allergies and medical notes
 * are `high`: a removed allergy is a child eating something they react to, and
 * it must not sit in a list next to a corrected house number. Everything else
 * is `normal`.
 *
 * Rows are never deleted or edited once written. Staff acknowledge them, which
 * is a different thing from making them go away.
 */
const changeSchema = new mongoose.Schema({
  field: { type: String, required: true },
  label: { type: String, default: '' },        // Hebrew, for the staff screen
  before: { type: mongoose.Schema.Types.Mixed, default: null },
  after: { type: mongoose.Schema.Types.Mixed, default: null },
}, { _id: false });

const parentPortalChangeSchema = new mongoose.Schema({
  parent_account_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ParentAccount', required: true, index: true },
  parent_id_number: { type: String, default: '' },
  // Snapshots, so the staff list reads correctly even after the underlying
  // records move on — which is the whole reason it exists.
  parent_name: { type: String, default: '' },
  child_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Child', default: null, index: true },
  child_name: { type: String, default: '' },
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },

  category: {
    type: String,
    enum: ['contact', 'health', 'phone', 'second_parent'],
    required: true,
  },
  severity: { type: String, enum: ['normal', 'high'], default: 'normal' },
  changes: { type: [changeSchema], default: [] },

  // Acknowledgement, not approval: the change is already live. This only
  // records that somebody at the gan has seen it.
  seen_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  seen_at: { type: Date, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

// The staff screen's one query: unseen first, newest first, by branch.
parentPortalChangeSchema.index({ seen_at: 1, created_at: -1 });

module.exports = mongoose.model('ParentPortalChange', parentPortalChangeSchema);
