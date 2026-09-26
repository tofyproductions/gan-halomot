'use strict';

const {
  Child, DailyLog, PickupAuthorization, ChildSupplies, ChildFaceReference, Photo,
} = require('../models');

/**
 * Everything that points at a registration's children, cleaned up BEFORE the
 * children are deleted.
 *
 * Archiving a registration used to delete Child rows and stop: daily logs,
 * pickup authorizations, supplies lists, photo tags and biometric face
 * references all kept pointing at ids that no longer resolve. The logs and
 * authorizations became unreachable junk; the face references — biometric
 * data of a child who LEFT — sat until the retention job happened to reap
 * them; and the gallery kept "מי זה?" tags naming a deleted child.
 *
 * Runs BEFORE Child.deleteMany on purpose: if the process dies mid-way, the
 * children still exist and re-running the archive heals the remainder. The
 * photos themselves are untouched — only their tags are; a group photo is
 * still every OTHER child's photo.
 *
 * @param {string|ObjectId} registrationId
 * @returns {Promise<object>} per-collection counts, for the caller's log line
 */
async function cleanupChildrenOfRegistration(registrationId) {
  const children = await Child.find({ registration_id: registrationId }).select('_id').lean();
  const ids = children.map(c => c._id);
  if (!ids.length) return { children: 0 };

  const [logs, pickups, supplies, faceRefs, photoTags, faceTags] = await Promise.all([
    DailyLog.deleteMany({ child_id: { $in: ids } }),
    PickupAuthorization.deleteMany({ child_id: { $in: ids } }),
    ChildSupplies.deleteMany({ child_id: { $in: ids } }),
    // Biometric references of a departed child are deleted NOW, not when the
    // retention job gets around to it.
    ChildFaceReference.deleteMany({ child_id: { $in: ids } }),
    Photo.updateMany(
      { child_ids: { $in: ids } },
      { $pull: { child_ids: { $in: ids } } },
    ),
    // Face boxes stay (they are geometry, not identity) — only the naming is
    // removed, exactly like a manual "הסר תיוג".
    Photo.updateMany(
      { 'faces.child_id': { $in: ids } },
      { $set: { 'faces.$[f].child_id': null } },
      { arrayFilters: [{ 'f.child_id': { $in: ids } }] },
    ),
  ]);

  return {
    children: ids.length,
    daily_logs: logs.deletedCount || 0,
    pickup_authorizations: pickups.deletedCount || 0,
    supplies: supplies.deletedCount || 0,
    face_references: faceRefs.deletedCount || 0,
    photos_untagged: (photoTags.modifiedCount || 0) + (faceTags.modifiedCount || 0),
  };
}

module.exports = { cleanupChildrenOfRegistration };
