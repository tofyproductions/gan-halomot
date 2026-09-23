const { Photo, ParentPhotoHidden } = require('../models');
const { MATCH_THRESHOLD } = require('./face/constants');

/**
 * What a parent is allowed to change about who is in a photograph.
 *
 * Three actions, and the difference between them is the design:
 *
 *   "זה לא הילד שלי"    a CORRECTION. The tag was wrong; it comes off for
 *                        everyone, and the system learns from it.
 *   "אל תציג לי את זה"  a PREFERENCE. The tag is right, they just do not want
 *                        the photograph. Nothing is learned. Without this
 *                        split, a parent hiding a photograph where their child
 *                        is crying teaches the recogniser that their child is
 *                        not their child.
 *   "זה כן הילד שלי"    an ADDITION, from the classroom gallery. It shows in
 *                        their feed at once — they can already see the
 *                        photograph there, so nothing is revealed — but it
 *                        does not teach until a member of staff agrees.
 *
 * The parent is the authority on who their own child is, so a correction beats
 * anything the scanner decided and anything a teacher typed. Where a teacher
 * disagrees, the datum is simply not counted rather than escalated: either the
 * teacher was wrong or the parent did not recognise their child from behind,
 * and nobody is harmed by either.
 */

/** The photographs this parent has hidden, as a Set of ids. */
async function hiddenIds({ parentId, childIds }) {
  const rows = await ParentPhotoHidden.find({
    parent_id: parentId,
    $or: [{ child_id: { $in: childIds } }, { child_id: null }],
  }).select('photo_id').lean();
  return new Set(rows.map((r) => String(r.photo_id)));
}

async function hide({ parentId, childId, photoId }) {
  await ParentPhotoHidden.updateOne(
    { parent_id: parentId, photo_id: photoId, child_id: childId },
    { $setOnInsert: { parent_id: parentId, photo_id: photoId, child_id: childId } },
    { upsert: true },
  );
  return { ok: true, hidden: true };
}

async function unhide({ parentId, childId, photoId }) {
  await ParentPhotoHidden.deleteOne({
    parent_id: parentId, photo_id: photoId, child_id: childId,
  });
  return { ok: true, hidden: false };
}

/**
 * "That is not my child."
 *
 * Takes the tag off entirely rather than merely hiding it: if the face is not
 * theirs it is nobody's until someone says otherwise, and leaving it attached
 * would keep the wrong photograph in a gallery and keep the wrong face in the
 * evidence the system learns from.
 *
 * Scoped to THEIR children. A parent can only unsay something that was said
 * about their own family; the other faces in the frame are not theirs to edit.
 */
async function notMyChild({ childIds, photoId, faceIndex }) {
  const photo = await Photo.findById(photoId);
  if (!photo) return { ok: false, reason: 'photo not found' };

  const face = photo.faces[faceIndex];
  if (!face) return { ok: false, reason: 'face not found' };

  const mine = childIds.map(String);
  if (!face.child_id || !mine.includes(String(face.child_id))) {
    return { ok: false, reason: 'that face is not tagged as your child' };
  }

  const removed = String(face.child_id);
  face.child_id = null;
  face.confidence = null;
  face.awaiting_staff = false;
  // Recorded as the parent's decision so a later scan does not simply put the
  // same name back — the scanner fills gaps, it never overrules someone who
  // looked.
  face.decided_by = 'parent';

  // The child comes off the photograph only if no OTHER face in it is still
  // theirs. A frame can legitimately hold one child and one mistake.
  const stillThere = photo.faces.some((f) => String(f.child_id) === removed);
  if (!stillThere) {
    photo.child_ids = photo.child_ids.filter((id) => String(id) !== removed);
  }

  await photo.save();
  return { ok: true, removed_child: removed };
}

/**
 * "That one IS my child" — from the classroom gallery.
 *
 * Counts for their own gallery straight away and waits for staff before it
 * teaches. Refused outright when the system is already confident the face
 * belongs to a different known child: that is not a data problem but a person
 * collecting photographs of somebody else's child, and it should be visible
 * rather than absorbed.
 */
async function isMyChild({ childId, childIds, photoId, faceIndex }) {
  if (!childIds.map(String).includes(String(childId))) {
    return { ok: false, reason: 'not your child' };
  }

  const photo = await Photo.findById(photoId);
  if (!photo) return { ok: false, reason: 'photo not found' };
  if (photo.source !== 'staff') return { ok: false, reason: 'not a gan photograph' };

  const face = photo.faces[faceIndex];
  if (!face) return { ok: false, reason: 'face not found' };

  if (face.child_id && String(face.child_id) !== String(childId)) {
    if (face.decided_by === 'staff' || (face.confidence || 0) >= MATCH_THRESHOLD) {
      return { ok: false, reason: 'that face is already known to be another child', flagged: true };
    }
  }

  // A child cannot be in one photograph twice.
  const already = photo.faces.findIndex(
    (f, i) => i !== Number(faceIndex) && String(f.child_id) === String(childId),
  );
  if (already > -1) return { ok: false, reason: 'your child is already marked in this photograph' };

  face.child_id = childId;
  face.decided_by = 'parent';
  face.confidence = null;
  face.awaiting_staff = true;
  face.not_a_child = false;

  const ids = new Set(photo.child_ids.map(String));
  ids.add(String(childId));
  photo.child_ids = [...ids];

  await photo.save();
  return { ok: true, awaiting_staff: true };
}

/**
 * The face boxes a parent may be shown for a photograph.
 *
 * Positions only, plus whether each one is their own child. Where every other
 * face belongs is not theirs to know — the photograph already shows the
 * children, and naming them would turn a gallery into a directory of other
 * people's families.
 */
function faceBoxes(photo, childIds) {
  const mine = childIds.map(String);
  return (photo.faces || [])
    .map((f, index) => ({
      index,
      bbox: f.bbox,
      is_mine: Boolean(f.child_id && mine.includes(String(f.child_id))),
      taken: Boolean(f.child_id),
    }))
    .filter((f) => !f.taken || f.is_mine);
}

module.exports = {
  hiddenIds, hide, unhide, notMyChild, isMyChild, faceBoxes,
};
