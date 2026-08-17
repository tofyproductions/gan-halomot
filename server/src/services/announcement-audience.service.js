const { Child, Classroom } = require('../models');
const { normalizePhone } = require('./sms.service');
const { getAcademicYears } = require('./academic-year.service');

/**
 * Who an announcement is actually for.
 *
 * Nothing in this system could answer that before. contacts.controller lists
 * every active child in every gan, reads only the first parent's number, and
 * renders HTML — useful for printing a class list and useless here, where the
 * answer decides how many text messages get paid for.
 *
 * Two facts shape all of it:
 *
 * A CHILD HAS NO BRANCH. `Child` carries a classroom and the classroom carries
 * the branch, so every "the whole gan" question is really two queries. Writing
 * it the obvious way — `Child.find({ branch_id })` — silently matches nothing.
 *
 * A FAMILY IS A PHONE, NOT A CHILD. Two siblings in the same gan share their
 * parents' numbers, and both parents of one child are two separate people to
 * reach. So the audience is a set of NUMBERS, deduplicated: three children of
 * two families is four messages, not six, and the budget is spent against what
 * was actually sent.
 */

/** The gan year we are in now, as 'YYYY-YYYY'. */
function currentYear() {
  return getAcademicYears().current.range;
}

/**
 * The classrooms an announcement covers.
 *
 * An empty `classroomIds` means the whole branch — and it is resolved HERE,
 * against the rooms that exist today, rather than being frozen into the record
 * when it was written. A room that opened last week is part of the gan.
 */
async function classroomsFor(branchId, classroomIds = []) {
  if (classroomIds && classroomIds.length) {
    // Still filtered by branch: an id from another gan in the request body
    // must not widen the audience, whatever the caller believed.
    return Classroom.find({
      _id: { $in: classroomIds },
      branch_id: branchId,
      is_active: true,
    }).select('_id name').lean();
  }
  return Classroom.find({ branch_id: branchId, is_active: true }).select('_id name').lean();
}

/**
 * The families in scope, and the numbers to reach them on.
 *
 * Returns { children, phones, families } where `phones` is deduplicated and
 * every entry has already been through normalizePhone — anything that is not
 * an Israeli mobile is dropped here rather than paid for and bounced by the
 * carrier. `unreachable` is the count of children with no usable number at
 * all, which is the figure a manager needs before she decides that sending is
 * enough: those families were not told, by any channel.
 */
async function audienceFor(branchId, classroomIds = [], year = null) {
  const academicYear = year || currentYear();
  const rooms = await classroomsFor(branchId, classroomIds);
  if (!rooms.length) {
    return { children: 0, phones: [], families: 0, unreachable: 0, classrooms: [] };
  }

  const children = await Child.find({
    classroom_id: { $in: rooms.map(r => r._id) },
    is_active: true,
    academic_year: academicYear,
  }).select('child_name phone parent2_phone').lean();

  const phones = new Set();
  let unreachable = 0;

  for (const c of children) {
    const mine = [c.phone, c.parent2_phone]
      .map(normalizePhone)
      .filter(Boolean);
    if (!mine.length) unreachable += 1;
    for (const p of mine) phones.add(p);
  }

  return {
    children: children.length,
    phones: [...phones],
    families: phones.size,
    unreachable,
    classrooms: rooms.map(r => ({ id: r._id, name: r.name })),
  };
}

/**
 * How many children the branch has, for sizing the month's budget.
 *
 * Deliberately the CHILD count and not the phone count. The budget is a policy
 * — two announcements to everybody — and it should not move because one family
 * has a second parent on file and another does not; spending is measured in
 * real messages, which is where that difference belongs.
 */
async function branchChildCount(branchId, year = null) {
  const academicYear = year || currentYear();
  const rooms = await Classroom.find({ branch_id: branchId, is_active: true }).select('_id').lean();
  if (!rooms.length) return 0;
  return Child.countDocuments({
    classroom_id: { $in: rooms.map(r => r._id) },
    is_active: true,
    academic_year: academicYear,
  });
}

module.exports = { audienceFor, branchChildCount, classroomsFor, currentYear };
