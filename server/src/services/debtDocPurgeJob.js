const { ReconcileDecision } = require('../models');
const storage = require('../services/storage.service');

/**
 * The week between deleting a debt document and it actually being gone.
 *
 * Deleting a signed repayment agreement is destroying the only evidence a
 * family agreed to anything, and it is nearly always an accident — the wrong
 * row, the wrong file, a fat thumb on a phone. So a delete hides the row at
 * once, mails the file to every system_admin, and leaves the bytes alone. This
 * job is the end of that week: it removes the objects whose grace has run out
 * and drops the sub-documents that pointed at them.
 *
 * Deliberately slow to act and quick to stop. A storage error on one object
 * leaves that one alone and moves on — a bucket having a bad morning must not
 * cost the database rows that still describe files which are still there.
 *
 * Daily; DISABLE_JOBS keeps it off in tests and in the demo.
 */
async function tick(now = new Date()) {
  if (!storage.isConfigured()) return { purged: 0, skipped: 'storage not configured' };

  const rows = await ReconcileDecision.find({
    'documents.purge_after': { $lte: now },
  }).select('documents');

  let purged = 0;
  let failed = 0;

  for (const decision of rows) {
    const due = decision.documents.filter(d => d.deleted_at && d.purge_after && d.purge_after <= now);
    if (!due.length) continue;

    const removable = [];
    for (const doc of due) {
      try {
        await storage.deleteObject(doc.key);
        removable.push(String(doc._id));
      } catch (err) {
        failed += 1;
        console.error(`[debt-docs] purge failed for ${doc.key}: ${err.message}`);
      }
    }

    if (!removable.length) continue;
    // Pulled by id rather than saved through the document: another request may
    // have added a file to this same family while the objects were deleting.
    await ReconcileDecision.updateOne(
      { _id: decision._id },
      { $pull: { documents: { _id: { $in: removable } } } },
    );
    purged += removable.length;
  }

  return { purged, failed };
}

module.exports = { tick };
