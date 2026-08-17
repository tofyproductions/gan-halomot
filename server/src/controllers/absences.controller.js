const { Absence, Classroom, DailyLog } = require('../models');
const { resolveBranchScope } = require('../utils/branch-scope');

/**
 * היעדרויות — what the families said in advance, for the people who open the
 * room in the morning.
 *
 * Read-only, all of it. Nothing on this screen writes an absence: the parent
 * reports and withdraws (controllers/parentAbsence), and what the staff record
 * is the day's own attendance on the nursery board. Giving the staff an edit
 * button here would produce two people writing the same fact in two places.
 *
 * THE DAY'S LIST SHOWS BOTH SIDES. Beside every reported absence sits what the
 * board actually says about that child — arrived, marked away, or nothing yet.
 * Where the two disagree is the useful part: a child reported away who walked
 * in is worth a teacher noticing before lunch is counted, and a child reported
 * away who was also marked away needs no attention at all.
 */

function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The classrooms this user may look at, as ids. */
async function visibleRooms(req, branchQuery) {
  const scope = await resolveBranchScope(req);
  const filter = { is_active: true };
  if (scope !== null) filter.branch_id = { $in: scope };
  if (branchQuery && branchQuery !== 'all') {
    // Narrowing inside the scope, never outside it: an id from a branch this
    // user does not manage simply produces an empty intersection.
    if (scope !== null && !scope.includes(String(branchQuery))) return [];
    filter.branch_id = branchQuery;
  }
  return Classroom.find(filter).select('_id name branch_id').lean();
}

/**
 * GET /api/absences?date=&branch=&classroom=
 * The morning list.
 */
async function day(req, res, next) {
  try {
    const date = req.query.date || dayKey();
    const rooms = await visibleRooms(req, req.query.branch);
    if (!rooms.length) return res.json({ date, absences: [], classrooms: [] });

    let ids = rooms.map(r => r._id);
    if (req.query.classroom && req.query.classroom !== 'all') {
      ids = ids.filter(id => String(id) === String(req.query.classroom));
    }

    const rows = await Absence.find({
      classroom_id: { $in: ids },
      date,
      cancelled_at: null,
    }).sort({ child_name: 1 }).lean();

    // What the board says about the same children on the same day. Absent
    // means nobody has written anything yet, which is different from "marked
    // present" and has to read differently.
    const logs = rows.length
      ? await DailyLog.find({
        child_id: { $in: rows.map(r => r.child_id) },
        date,
      }).select('child_id attendance').lean()
      : [];
    const attendanceOf = new Map(logs.map(l => [String(l.child_id), l.attendance || '']));

    const roomName = new Map(rooms.map(r => [String(r._id), r.name]));

    res.json({
      date,
      classrooms: rooms.map(r => ({ id: r._id, name: r.name, branch_id: r.branch_id })),
      absences: rows.map(a => ({
        id: a._id,
        child_id: a.child_id,
        child_name: a.child_name,
        classroom: roomName.get(String(a.classroom_id)) || '',
        reason: a.reason,
        reported_by: a.reported_by_name,
        reported_at: a.created_at,
        // '' | 'הגיע' | 'חסר' — the board's own word, not this record's.
        board_says: attendanceOf.get(String(a.child_id)) || '',
      })),
    });
  } catch (e) { next(e); }
}

/**
 * GET /api/absences/report?from=&to=&branch=
 *
 * How many days each child was reported away over a period.
 *
 * The point is not the total, it is the tail: a child at fifteen days in a
 * term is a conversation somebody should be having, and nobody notices that
 * from a daily list. Sorted by count so that conversation is at the top.
 */
async function report(req, res, next) {
  try {
    const to = req.query.to || dayKey();
    const from = req.query.from || `${to.slice(0, 7)}-01`;
    const rooms = await visibleRooms(req, req.query.branch);
    if (!rooms.length) return res.json({ from, to, rows: [] });

    const rows = await Absence.aggregate([
      {
        $match: {
          classroom_id: { $in: rooms.map(r => r._id) },
          date: { $gte: from, $lte: to },
          cancelled_at: null,
        },
      },
      {
        $group: {
          _id: '$child_id',
          child_name: { $first: '$child_name' },
          classroom_id: { $first: '$classroom_id' },
          days: { $sum: 1 },
          dates: { $push: '$date' },
        },
      },
      { $sort: { days: -1, child_name: 1 } },
      { $limit: 300 },
    ]);

    const roomName = new Map(rooms.map(r => [String(r._id), r.name]));
    res.json({
      from,
      to,
      rows: rows.map(r => ({
        child_id: r._id,
        child_name: r.child_name,
        classroom: roomName.get(String(r.classroom_id)) || '',
        days: r.days,
        dates: r.dates.sort(),
      })),
    });
  } catch (e) { next(e); }
}

module.exports = { day, report };
