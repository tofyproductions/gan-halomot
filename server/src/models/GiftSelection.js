const mongoose = require('mongoose');

/**
 * One child's gift, for one campaign.
 *
 * Two decisions live here and they belong to different people, which is why
 * they are two fields rather than one.
 *
 * `parent_photo_ids` — what the family chose, up to the campaign's number.
 * `final_photo_id` — what actually goes on the gift, chosen by the staff from
 * the family's picks, or chosen by the staff outright when nobody picked.
 *
 * Collapsed into one field, the record could no longer answer "did this family
 * choose, or did we choose for them" — which is the question the office gets
 * asked when a parent says they picked something else.
 */
const giftSelectionSchema = new mongoose.Schema({
  campaign_id: { type: mongoose.Schema.Types.ObjectId, ref: 'GiftCampaign', required: true, index: true },
  child_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Child', required: true, index: true },

  // Snapshots, so the supplier file and the staff screen still read correctly
  // after a child moves room or leaves.
  child_name: { type: String, default: '' },
  classroom_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Classroom', default: null, index: true },
  classroom_name: { type: String, default: '' },
  classroom_category: { type: String, default: '' },
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
  branch_name: { type: String, default: '' },

  parent_photo_ids: { type: [mongoose.Schema.Types.ObjectId], ref: 'Photo', default: [] },
  chosen_at: { type: Date, default: null },
  chosen_by_parent: { type: mongoose.Schema.Types.ObjectId, ref: 'ParentAccount', default: null },

  final_photo_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Photo', default: null },
  // Which of the two people decided. A gift the staff picked because the
  // deadline passed is a different fact from one the staff picked out of what
  // the family offered, and the office needs to be able to tell them apart.
  final_source: { type: String, enum: ['', 'from_parent_picks', 'staff_only'], default: '' },
  final_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  final_by_name: { type: String, default: '' },
  final_at: { type: Date, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

// One row per child per campaign, enforced rather than assumed.
giftSelectionSchema.index({ campaign_id: 1, child_id: 1 }, { unique: true });

module.exports = mongoose.model('GiftSelection', giftSelectionSchema);
