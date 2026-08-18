const mongoose = require('mongoose');

/**
 * A node in the customer's own org chart. Lives in the CUSTOMER's database,
 * not the control plane — it is their structure, and nobody else's business.
 *
 * NOT THREE FIXED LEVELS. אמונה says מחוז; the next network will say אזור and
 * want אשכול underneath it; a single gan wants no levels at all and one row.
 * Writing רשת→מחוז→סניף into the schema means the second network we sell to
 * breaks it, so a unit simply holds a parent and the depth is whatever the
 * customer's own chart happens to be.
 *
 * `kind` is a LABEL, not a rank. It decides the word on the screen and nothing
 * else — no code branches on it, so a customer inventing a level we have never
 * heard of costs a string.
 *
 * `path` is the ancestry, materialised. Every real question here is "everything
 * under this node" — a district manager's dashboard, a network's collections,
 * who may see what — and asking it by walking parents is one query per level
 * against a tree 500 branches wide. Stored as ancestor ids, it is one indexed
 * query. It is derived data and it is rewritten on every move, in `reparent`.
 */
const orgUnitSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },

  kind: { type: String, default: 'branch' },   // network | district | cluster | branch | anything

  parent_id: { type: mongoose.Schema.Types.ObjectId, ref: 'OrgUnit', default: null, index: true },

  // Ancestors, root first, excluding self.
  path: { type: [mongoose.Schema.Types.ObjectId], default: [], index: true },
  depth: { type: Number, default: 0 },

  /**
   * The gan itself, when this node is one. A leaf points at the Branch that
   * already carries the clock, the classrooms and the children; the tree above
   * it is new and the gan below it is untouched. Interior nodes leave it null.
   */
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },

  sort_order: { type: Number, default: 0 },
  is_active: { type: Boolean, default: true },
  notes: { type: String, default: '' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

orgUnitSchema.index({ parent_id: 1, sort_order: 1 });

/**
 * Move a node, and carry its descendants with it.
 *
 * The descendants are the reason this is a method rather than a field
 * assignment: their stored ancestry still names the old parent, and a district
 * that reports the wrong branches is worse than one that reports none.
 */
orgUnitSchema.statics.reparent = async function reparent(id, newParentId) {
  const Unit = this;
  const node = await Unit.findById(id);
  if (!node) throw new Error('unit not found');

  const parent = newParentId ? await Unit.findById(newParentId) : null;
  if (newParentId && !parent) throw new Error('parent not found');

  // A node cannot be moved under itself or under anything it contains.
  if (parent && (String(parent._id) === String(node._id) || parent.path.some((p) => String(p) === String(node._id)))) {
    throw new Error('cannot move a unit under its own descendant');
  }

  const oldPath = [...node.path, node._id];
  const newPath = parent ? [...parent.path, parent._id] : [];

  node.parent_id = parent ? parent._id : null;
  node.path = newPath;
  node.depth = newPath.length;
  await node.save();

  const descendants = await Unit.find({ path: node._id });
  for (const d of descendants) {
    const tail = d.path.slice(oldPath.length);
    d.path = [...newPath, node._id, ...tail];
    d.depth = d.path.length;
    await d.save();
  }
  return node;
};

/** Every unit at or below `id`, self included. */
orgUnitSchema.statics.subtree = function subtree(id) {
  return this.find({ $or: [{ _id: id }, { path: id }] }).sort({ depth: 1, sort_order: 1 });
};

/** The branch ids a person holding `unitIds` may see. */
orgUnitSchema.statics.branchesUnder = async function branchesUnder(unitIds) {
  const ids = [].concat(unitIds || []);
  if (!ids.length) return [];
  const units = await this.find({
    $or: [{ _id: { $in: ids } }, { path: { $in: ids } }],
    branch_id: { $ne: null },
  }).select('branch_id');
  return [...new Set(units.map((u) => String(u.branch_id)))];
};

module.exports = orgUnitSchema;
