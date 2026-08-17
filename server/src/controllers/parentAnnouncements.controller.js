const { Announcement } = require('../models');
const { loadOwnChild } = require('./parentPortal.controller');

/**
 * What the gan has told this family.
 *
 * Addressed by CLASSROOM, resolved here rather than stored on the parent. An
 * announcement carries either a list of rooms or nothing at all, and nothing
 * means the whole branch — so a room that opened last week is covered by a
 * notice written last month without anybody editing it.
 *
 * Expired ones are gone. "הגן סגור מחר" three weeks later is not an old
 * announcement, it is a false statement, and leaving it on the screen under a
 * date nobody reads is how a parent ends up keeping a child at home.
 *
 * The staff shape carries an author, an approver, a rejection reason and what
 * a send cost. None of that is the family's, so the fields below are listed
 * one at a time rather than spread — the same rule as the payments screen.
 */
async function childAnnouncements(req, res) {
  const own = await loadOwnChild(req);
  if (!own) return res.status(404).json({ error: 'לא נמצא' });

  const { child } = own;
  const branchId = child.classroom_id?.branch_id || null;
  // No classroom means no branch to scope by, and answering with somebody
  // else's gan is worse than answering with nothing.
  if (!branchId) return res.json({ announcements: [] });

  const classroomId = child.classroom_id?._id || child.classroom_id;
  const now = new Date();

  const docs = await Announcement.find({
    branch_id: branchId,
    status: 'published',
    $and: [
      { $or: [{ expires_at: null }, { expires_at: { $gt: now } }] },
      // Empty list = the whole branch. `$size: 0` rather than a null check,
      // because the field always exists as an array.
      { $or: [{ classroom_ids: { $size: 0 } }, { classroom_ids: classroomId }] },
    ],
  })
    .sort({ published_at: -1 })
    .limit(40)
    .lean();

  return res.json({
    announcements: docs.map(a => ({
      id: a._id,
      title: a.title,
      body: a.body,
      is_urgent: a.is_urgent,
      published_at: a.published_at,
      // True when it was addressed to this child's room rather than to
      // everyone — the screen says so, because "this is for your class" is
      // the difference between reading it now and reading it later.
      for_my_class: (a.classroom_ids || []).length > 0,
      expires_at: a.expires_at,
    })),
  });
}

module.exports = { childAnnouncements };
