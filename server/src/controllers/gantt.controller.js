const mongoose = require('mongoose');
const { GanttMonth, Holiday, Classroom } = require('../models');
const pv = require('../services/parentVisibility');

// The five rows the gan actually writes, in the order the paper workbook uses.
//
// The craft row was missing here while every real yearly workbook has it — so a
// gananet moving off the spreadsheet had nowhere to put the one row she fills in
// every single day, and had to add it by hand to each new month.
//
// It is labelled הנגשת חומרים rather than יצירה because that is what the gan
// calls it: the row is what is PUT OUT for the children to work with, and the
// creating is theirs. The key stays `creation` — renaming it would orphan every
// cell already saved under it.
//
// Only new gantts pick this up. A month already saved keeps the rows it was
// saved with, deliberately: silently inserting a row into an approved plan
// changes a document a manager has signed off.
const DEFAULT_ROWS = [
  { key: 'meeting', label: 'מפגש' },
  { key: 'activity', label: 'פעילות' },
  { key: 'creation', label: 'הנגשת חומרים' },
  { key: 'story', label: 'סיפור' },
  { key: 'misc', label: 'שונות' },
];

async function get(req, res, next) {
  try {
    const { branch, classroom, month, year } = req.query;
    if (!classroom || !month || !year) {
      return res.status(400).json({ error: 'classroom, month, year required' });
    }

    let gantt = await GanttMonth.findOne({
      classroom_id: classroom,
      month: parseInt(month),
      year: parseInt(year),
    }).populate('approved_by', 'full_name').lean();

    // If not found, return empty template with weeks
    if (!gantt) {
      // Prefer an explicit valid branch; otherwise ('all'/missing) fall back to
      // the classroom's own branch so a later save stores the correct branch_id.
      let branchId = (branch && mongoose.isValidObjectId(branch)) ? branch : null;
      if (!branchId && mongoose.isValidObjectId(classroom)) {
        const room = await Classroom.findById(classroom).select('branch_id').lean();
        branchId = room?.branch_id || null;
      }
      gantt = {
        _id: null,
        branch_id: branchId,
        classroom_id: classroom,
        month: parseInt(month),
        year: parseInt(year),
        status: 'draft',
        row_definitions: DEFAULT_ROWS,
        weeks: generateWeeks(parseInt(month), parseInt(year)),
        approved_by: null,
        approved_at: null,
      };
    }

    // Months saved before weeks began on Sunday are re-based on the way out, so
    // the screen never has to know two shapes. Nothing moves: start date and
    // indices shift together.
    gantt.weeks = normalizeWeeks(gantt.weeks);

    // A plan saved during the hour the craft row was called יצירה keeps that
    // word until somebody edits it, which would leave two gantts side by side
    // naming the same row differently. Relabelled on the way out rather than
    // migrated: it is the label only, the key is what cells are stored against,
    // and rewriting saved documents to change a caption is not worth the risk.
    gantt.row_definitions = (gantt.row_definitions || []).map(r => (
      r.key === 'creation' && r.label === 'יצירה' ? { ...r, label: 'הנגשת חומרים' } : r
    ));

    // Get holidays for this month. Only query when we have a real branch id —
    // an "all" / missing branch (e.g. the cross-branch view) is not an ObjectId
    // and would throw a CastError, which previously 500'd the whole gantt load.
    const startOfMonth = new Date(parseInt(year), parseInt(month) - 1, 1);
    const endOfMonth = new Date(parseInt(year), parseInt(month), 0);

    let holidays = [];
    if (gantt.branch_id && mongoose.isValidObjectId(gantt.branch_id)) {
      holidays = await Holiday.find({
        branch_id: gantt.branch_id,
        start_date: { $lte: endOfMonth },
        end_date: { $gte: startOfMonth },
      }).lean();
    }

    gantt.id = gantt._id;
    res.json({ gantt, holidays: holidays.map(h => ({ ...h, id: h._id })) });
  } catch (error) { next(error); }
}

async function save(req, res, next) {
  try {
    const {
      branch_id, classroom_id, academic_year,
      month, year, row_definitions, weeks, status,
    } = req.body;

    if (!classroom_id || !month || !year) {
      return res.status(400).json({ error: 'classroom_id, month, year required' });
    }

    let gantt = await GanttMonth.findOne({
      classroom_id, month: parseInt(month), year: parseInt(year),
    });

    if (gantt) {
      // Update existing
      if (row_definitions) gantt.row_definitions = row_definitions;
      if (weeks) gantt.weeks = normalizeWeeks(weeks);
      if (status) gantt.status = status;
      await gantt.save();
    } else {
      // Create new
      gantt = await GanttMonth.create({
        branch_id,
        classroom_id,
        academic_year: academic_year || '',
        month: parseInt(month),
        year: parseInt(year),
        row_definitions: row_definitions || DEFAULT_ROWS,
        weeks: weeks ? normalizeWeeks(weeks) : generateWeeks(parseInt(month), parseInt(year)),
        status: status || 'draft',
      });
    }

    res.json({ gantt: { ...gantt.toObject(), id: gantt._id } });
  } catch (error) { next(error); }
}

async function approve(req, res, next) {
  try {
    const gantt = await GanttMonth.findById(req.params.id);
    if (!gantt) return res.status(404).json({ error: 'גאנט לא נמצא' });

    gantt.status = 'approved';
    gantt.approved_by = req.user?.id || null;
    gantt.approved_at = new Date();
    await gantt.save();

    res.json({ message: 'גאנט אושר', gantt: { ...gantt.toObject(), id: gantt._id } });
  } catch (error) { next(error); }
}

async function getArchive(req, res, next) {
  try {
    const { classroom, branch } = req.query;
    const filter = {};
    if (classroom) filter.classroom_id = classroom;
    if (branch) filter.branch_id = branch;

    const gantts = await GanttMonth.find(filter)
      .select('classroom_id month year status approved_at')
      .populate('classroom_id', 'name')
      .sort({ year: -1, month: -1 })
      .lean();

    res.json({
      archive: gantts.map(g => ({
        ...g, id: g._id,
        classroom_name: g.classroom_id?.name || '',
      })),
    });
  } catch (error) { next(error); }
}

/**
 * The month's weeks, every one of them a whole ראשון–שישי.
 *
 * A week is not clipped to the month. The gan changes its subject after a FULL
 * week and never at the turn of a month, so the two or three days a week
 * borrows from August are part of that week's subject and have to be writable
 * — which they cannot be if the week does not start where the week starts.
 * The first week therefore begins on the Sunday ON OR BEFORE the 1st, even
 * when that Sunday is in the previous month.
 *
 * That also makes `day_index` mean the same thing everywhere: 0 is ראשון, for
 * every week of every month, which is the whole reason the days used to be
 * mislabelled.
 */
function generateWeeks(month, year) {
  const weeks = [];
  const firstDay = new Date(year, month - 1, 1);
  const lastDay = new Date(year, month, 0);

  // Back up to this week's Sunday.
  const current = new Date(firstDay);
  current.setDate(current.getDate() - current.getDay());

  let weekNum = 1;
  while (current <= lastDay) {
    const weekStart = new Date(current);
    const weekEnd = new Date(current);
    weekEnd.setDate(weekEnd.getDate() + 5); // Sun-Fri

    weeks.push({
      week_number: weekNum++,
      start_date: weekStart,
      end_date: weekEnd,
      topic: '',
      cells: [],
      friday_parent_father: '',
      friday_parent_mother: '',
    });

    current.setDate(current.getDate() + 7);
  }

  return weeks;
}

/**
 * Re-base a stored month onto Sunday-starting weeks, without moving a thing.
 *
 * Months saved before this shape existed have a first week that starts on the
 * 1st, with `day_index` counted from there. Both the start date and every
 * index are shifted by the SAME number of days, so every cell keeps the exact
 * calendar day it was written for — this is a change of coordinates, not of
 * content, and it is safe to apply to an approved plan.
 *
 * Idempotent: a week that already starts on a Sunday is returned untouched.
 */
function normalizeWeeks(weeks) {
  return (weeks || []).map((w) => {
    const start = new Date(w.start_date);
    const offset = start.getDay();
    if (!offset) return w;

    const sunday = new Date(start);
    sunday.setDate(sunday.getDate() - offset);
    const friday = new Date(sunday);
    friday.setDate(friday.getDate() + 5);

    return {
      ...w,
      start_date: sunday,
      end_date: friday,
      cells: (w.cells || [])
        .map((c) => ({ ...(c.toObject ? c.toObject() : c), day_index: c.day_index + offset }))
        // A Saturday cell cannot exist on a ראשון–שישי grid. It was never drawn
        // and never writable, so there is nothing in it to lose.
        .filter((c) => c.day_index >= 0 && c.day_index <= 5),
    };
  });
}


// ---------------------------------------------------------------------------
// מה ההורים רואים — one switch per branch per week, for the gantt and the menu.
//
// The gan asked to decide week by week rather than once and for all, because
// a week that is still being written is not a week anybody wants read.
// ---------------------------------------------------------------------------

/** GET /api/gantt/visibility?branch=<id>&weeks=8 — this week and the next few. */
async function getVisibility(req, res, next) {
  try {
    const branchId = req.query.branch;
    if (!branchId || branchId === 'all') return res.status(400).json({ error: 'יש לבחור סניף' });

    const count = Math.min(Math.max(Number(req.query.weeks) || 8, 1), 26);
    const today = pv.ymdOf(new Date());
    const start = new Date(`${pv.weekStart(today)}T12:00:00.000Z`);

    const weeks = [];
    for (let i = 0; i < count; i += 1) {
      const d = new Date(start);
      d.setUTCDate(d.getUTCDate() + i * 7);
      const ymd = d.toISOString().slice(0, 10);
      const state = await pv.visibilityFor(branchId, pv.weekKey(ymd));
      weeks.push({ ...state, start: ymd, dates: pv.weekDates(ymd) });
    }
    res.json({ weeks });
  } catch (error) { next(error); }
}

/** PUT /api/gantt/visibility   { branch_id, week, gantt?, menu? } */
async function setVisibility(req, res, next) {
  try {
    const { ParentVisibility } = require('../models');
    const { branch_id: branchId, week } = req.body || {};
    if (!branchId || !week) return res.status(400).json({ error: 'יש לציין סניף ושבוע' });

    // Only the switches actually sent are written, so a screen that shows one
    // of them cannot silently reset the other.
    const set = {
      set_by: req.user?.id || null,
      set_by_name: req.user?.full_name || '',
    };
    if (req.body.gantt !== undefined) set.gantt = !!req.body.gantt;
    if (req.body.menu !== undefined) set.menu = !!req.body.menu;

    await ParentVisibility.findOneAndUpdate(
      { branch_id: branchId, week },
      { $set: set },
      { upsert: true, new: true },
    );
    res.json(await pv.visibilityFor(branchId, week));
  } catch (error) { next(error); }
}

// generateWeeks is exported for scripts/gantt-weekdays.test.js — the shape of a
// month's weeks is what decides which box is which day, and that has been wrong.
module.exports = {
  get, save, approve, getArchive, getVisibility, setVisibility,
  generateWeeks, normalizeWeeks, DEFAULT_ROWS,
};
