const mongoose = require('mongoose');

/**
 * Somebody other than a parent who may collect this child.
 *
 * The list exists on paper in every gan and nowhere in this system, which
 * means it is out of date, it is in a folder in one branch's office, and the
 * question "may the grandmother take her today" is answered by whoever happens
 * to be at the door.
 *
 * THE PARENT PROPOSES, THE GAN GRANTS. Nothing here is a permission until
 * somebody at the gan has approved it — the same shape as adding a second
 * parent, and for the same reason: a screen that says "דנה כהן מורשית" because
 * a phone was left unlocked is a feeling of safety rather than safety.
 *
 * AND IT IS ASYMMETRIC ON PURPOSE. Granting waits for the gan. REVOKING DOES
 * NOT — a parent taking somebody off this list is answering a question nobody
 * should have to explain to an office first, and a revocation that waits for
 * approval is a revocation that has not happened. The one direction that can
 * only make the list smaller needs no gate.
 *
 * NO ID NUMBER, DELIBERATELY. A parent typing a grandmother's or a
 * neighbour's identity number is handing over a third party's personal data
 * that the third party never agreed to, and the field would be filled the
 * moment it existed. What the staff actually do at the door is ask to see a
 * document and read the name off it, which needs a name — so this record
 * carries a name, a telephone number and a relationship, and both screens say
 * plainly that identification happens at the door.
 */
const pickupSchema = new mongoose.Schema({
  child_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Child', required: true },
  classroom_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Classroom', default: null },
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
  child_name: { type: String, default: '' },

  name: { type: String, required: true, trim: true, maxlength: 80 },
  // Normalised to 05XXXXXXXX on the way in — the staff ring it, and a number
  // typed as +972 is a number nobody can tap.
  phone: { type: String, default: '', maxlength: 20 },
  // 'סבתא', 'שכנה', 'מונית'. Free text: the list of relationships a family can
  // have is not one anybody should be asked to pick from.
  relation: { type: String, default: '', maxlength: 60 },

  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'revoked'],
    default: 'pending',
  },

  added_by: { type: mongoose.Schema.Types.ObjectId, ref: 'ParentAccount', default: null },
  added_by_name: { type: String, default: '' },

  decided_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  decided_by_name: { type: String, default: '' },
  decided_at: { type: Date, default: null },
  // Why the gan said no. Shown to the parent, because "rejected" with no
  // reason is a family telephoning the office to ask what happened.
  reject_reason: { type: String, default: '', maxlength: 300 },

  revoked_at: { type: Date, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

// The door's question: who may collect this child.
pickupSchema.index({ child_id: 1, status: 1 });
// The manager's queue.
pickupSchema.index({ branch_id: 1, status: 1, created_at: -1 });

module.exports = mongoose.model('PickupAuthorization', pickupSchema);
