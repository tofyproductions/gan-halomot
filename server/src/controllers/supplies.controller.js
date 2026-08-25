/**
 * מה חסר לילדי הגן.
 *
 * One screen per gan rather than per room, because the question a manager asks
 * at the door is "who owes me something" and the answer crosses rooms.
 *
 * A child's branch is NOT stored on the child — it comes from the classroom,
 * and thirty-odd children have no classroom at any given moment (mid-placement,
 * a new intake, a room that was deleted). Those children cannot be filed under
 * a branch by any honest rule, so they are counted and reported rather than
 * quietly dropped: a roster that silently omits people is worse than one that
 * says it is short.
 */
const { Child, Classroom, ChildSupplies } = require('../models');
const supplies = require('../services/supplies');
const { getAcademicYears } = require('../services/academic-year.service');

const idStr = (v) => (v == null ? null : String(v._id || v));

/**
 * GET /api/supplies?branch=<id>&year=<תשפ״ז>
 * The catalogue plus every child in the branch and what they are short of.
 */
async function roster(req, res, next) {
  try {
    const branchId = req.query.branch;
    if (!branchId || branchId === 'all') {
      return res.status(400).json({ error: 'יש לבחור סניף' });
    }
    const year = req.query.year || getAcademicYears().current.range;

    const rooms = await Classroom.find({ branch_id: branchId, is_active: true })
      .select('name academic_year').sort({ name: 1 }).lean();
    const roomIds = rooms.map((r) => r._id);
    const roomName = new Map(rooms.map((r) => [String(r._id), r.name]));

    const children = await Child.find({
      is_active: true, academic_year: year, classroom_id: { $in: roomIds },
    }).select('child_name classroom_id parent_name phone').sort({ child_name: 1 }).lean();

    const rows = await ChildSupplies.find({
      child_id: { $in: children.map((c) => c._id) },
    }).lean();
    const byChild = new Map(rows.map((r) => [String(r.child_id), r]));

    // Children with no room at all: they exist, they are not on this list, and
    // the screen says so rather than letting the count look complete.
    const unplaced = await Child.countDocuments({
      is_active: true, academic_year: year,
      $or: [{ classroom_id: null }, { classroom_id: { $exists: false } }],
    });

    res.json({
      catalogue: supplies.CATALOGUE,
      catalogue_note: supplies.CATALOGUE_NOTE,
      academic_year: year,
      unplaced_children: unplaced,
      children: children.map((c) => {
        const row = byChild.get(String(c._id));
        return {
          id: String(c._id),
          name: c.child_name,
          classroom_id: idStr(c.classroom_id),
          classroom_name: roomName.get(String(c.classroom_id)) || '',
          parent_name: c.parent_name || '',
          phone: c.phone || '',
          missing: (row?.missing || []).map(supplies.decorate),
          updated_by_name: row?.updated_by_name || '',
          updated_at: row?.updated_at || null,
        };
      }),
    });
  } catch (error) { next(error); }
}

/**
 * PUT /api/supplies/:childId   { missing: [{ key, label?, note? }] }
 *
 * The whole list, not a delta: the screen shows what is ticked and sends what
 * is ticked, so an item that vanished from the payload was unticked and is no
 * longer missing. A delta would need the client and the server to agree about
 * an ordering they have no way to agree about.
 */
async function setForChild(req, res, next) {
  try {
    const child = await Child.findById(req.params.childId)
      .select('child_name classroom_id').lean();
    if (!child) return res.status(404).json({ error: 'ילד/ה לא נמצא/ה' });

    const room = child.classroom_id
      ? await Classroom.findById(child.classroom_id).select('branch_id').lean()
      : null;

    const existing = await ChildSupplies.findOne({ child_id: child._id });
    const merged = supplies.mergeMissing(existing?.missing, req.body?.missing, {
      id: req.user?.id || null, full_name: req.user?.full_name || '',
    });

    const doc = await ChildSupplies.findOneAndUpdate(
      { child_id: child._id },
      {
        $set: {
          branch_id: room?.branch_id || null,
          classroom_id: child.classroom_id || null,
          missing: merged,
          updated_by_name: req.user?.full_name || '',
          // Stamped only on the transition to empty, so "nothing is missing"
          // can be told apart from "nobody has ever looked".
          ...(merged.length === 0 && (existing?.missing || []).length > 0
            ? { last_cleared_at: new Date() } : {}),
        },
      },
      { upsert: true, new: true },
    );

    res.json({
      child_id: String(child._id),
      missing: (doc.missing || []).map(supplies.decorate),
    });
  } catch (error) { next(error); }
}

module.exports = { roster, setForChild };
