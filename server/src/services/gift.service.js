const { GiftCampaign, Photo } = require('../models');
const nursery = require('./nursery.service');

/**
 * The rules a gift round runs by, in one place because both sides ask them.
 *
 * A parent's screen needs to know whether choosing is still open; the staff's
 * needs to know the same thing to decide whether "nobody chose" is a fact yet
 * or just the morning. Answered twice, in two files, the two would eventually
 * disagree on a Friday afternoon.
 */

/**
 * Below this, a photograph should not go on a printed gift.
 *
 * Uploads are capped at 1600px, so anything smaller arrived smaller — a
 * WhatsApp forward, or a screenshot. At 1200px the long edge still prints a
 * 15x20 acceptably; under it, the mug comes back blurry and nobody finds out
 * until the box arrives.
 */
const MIN_PRINT_EDGE = 1200;

function isLowResolution(photo) {
  const longEdge = Math.max(photo?.width || 0, photo?.height || 0);
  return longEdge > 0 && longEdge < MIN_PRINT_EDGE;
}

/** Open for parents: the switch is on AND today is inside the window. */
function isOpenForParents(campaign, today = nursery.todayKey()) {
  if (!campaign || !campaign.is_open) return false;
  return campaign.opens_on <= today && today <= campaign.closes_on;
}

/**
 * The campaign a parent should be shown.
 *
 * The one whose window covers today. Failing that, the most recent one still
 * marked open — a deadline that passed this morning should still show the
 * family what they chose, rather than making the round vanish the moment it
 * closed.
 */
async function currentCampaign(today = nursery.todayKey()) {
  const live = await GiftCampaign.findOne({
    is_open: true,
    opens_on: { $lte: today },
    closes_on: { $gte: today },
  }).sort({ closes_on: 1 }).lean();
  if (live) return live;

  return GiftCampaign.findOne({ is_open: true }).sort({ closes_on: -1 }).lean();
}

/**
 * The photographs a parent may choose from for a given child.
 *
 * Exactly the "my child" stream: what the staff tagged the child in, plus what
 * the family uploaded themselves. Never the classroom gallery — a gift is the
 * child's, and a parent choosing a group photograph would put another family's
 * children on a mug they never agreed to.
 */
async function selectablePhotos(childIds, parentAccountId) {
  return Photo.find({
    $or: [
      { child_ids: { $in: childIds }, source: 'staff' },
      { source: 'parent', uploaded_by_parent: parentAccountId, child_ids: { $in: childIds } },
    ],
  }).sort({ date: -1, created_at: -1 }).limit(120).lean();
}

module.exports = {
  isLowResolution, isOpenForParents, currentCampaign, selectablePhotos,
  MIN_PRINT_EDGE,
};
