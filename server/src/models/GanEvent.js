const mongoose = require('mongoose');

/**
 * GanEvent — an event a branch manager creates so parents can commit to bringing
 * items (a party, a trip, a holiday breakfast...). The manager builds a list of
 * items, publishes a public link, and parents claim items first-come-first-served.
 *
 * Claiming model — each ITEM IS ONE SLOT (one claimable unit). "מגש ירקות ×7" is
 * stored as 7 separate slots that all share the same `name`. This makes a claim
 * an atomic compare-and-set on a single slot (positional `$` + a null guard),
 * with NO counting and NO race between two parents grabbing the last one. The
 * parent-facing UI groups slots by name for display ("נשארו 3 מתוך 7").
 *
 * Parent identity — parents have no login. A claim records:
 *   - claimant_id : a UUID minted in the parent's browser (localStorage), so a
 *                   return visit from the same device highlights their picks.
 *   - parent_phone: lets the same parent re-identify from a different device.
 *   - parent_name : shown to the manager and on the exported PDF.
 */
const eventItemSchema = new mongoose.Schema({
  name: { type: String, required: true },   // e.g. 'מגש ירקות'
  sort: { type: Number, default: 0 },       // display order (import/manual order)
  // Claim state — null claimed_by_id ⇒ the slot is free.
  claimed_by_id: { type: String, default: null },
  parent_name: { type: String, default: '' },
  parent_phone: { type: String, default: '' },
  claimed_at: { type: Date, default: null },
});

const ganEventSchema = new mongoose.Schema({
  // Each document is ONE branch's instance of an event. A multi-branch event
  // (a "campaign") is a set of instances that share a `group_id`: each branch
  // gets its own item list, its own parent link, and its own claims, but they
  // are managed together and every participating manager sees the whole group.
  // A plain single-branch event is just a campaign with one instance.
  group_id: { type: String, required: true, index: true },
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  // All branches in the campaign — denormalized onto every instance so any
  // manager who manages one of them can see (and co-manage) the whole group.
  member_branch_ids: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Branch' }],
  name: { type: String, required: true },
  event_date: { type: String, default: '' },   // 'YYYY-MM-DD'
  event_time: { type: String, default: '' },    // 'HH:mm'
  description: { type: String, default: '' },    // free notes shown to parents

  // Public parent link.
  access_token: { type: String, required: true, unique: true },
  // draft   — being edited, link not meant for sharing yet
  // published — link live, parents can claim
  // closed  — no more claims accepted (manager finished / event passed)
  status: { type: String, enum: ['draft', 'published', 'closed'], default: 'draft' },

  // By default a parent may claim only ONE item from the list. When the manager
  // turns this on, a parent can claim as many items as they like.
  allow_multiple_per_parent: { type: Boolean, default: false },

  items: { type: [eventItemSchema], default: [] },

  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

ganEventSchema.index({ branch_id: 1, created_at: -1 });
ganEventSchema.index({ member_branch_ids: 1, created_at: -1 });

module.exports = mongoose.model('GanEvent', ganEventSchema);
