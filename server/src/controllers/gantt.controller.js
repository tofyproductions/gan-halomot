const mongoose = require('mongoose');
const { GanttMonth, Holiday, Classroom, User, Child, Registration } = require('../models');
const shabbat = require('../services/shabbatParents');
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

/**
 * The school year a calendar month belongs to. September starts the year, so
 * September 2026 is 2026-2027 and February 2027 is the same year.
 */
const academicYearFor = (month, year) => (
  `${month >= 9 ? year : year - 1}-${month >= 9 ? year + 1 : year}`
);

/** Managers see and write every room's plan. */
const MANAGER_ROLES = ['system_admin', 'branch_manager', 'accountant'];
const isManager = (user) => MANAGER_ROLES.includes(user?.role);

/**
 * May this person write this room's plan?
 *
 * A manager always may. Otherwise it is the room's own leads — the list on the
 * classroom, plus `lead_teacher_id` for the rooms that were set up before the
 * list existed. Anyone else can read the plan and cannot change it: before
 * this, every logged-in member of staff could rewrite any room in any branch,
 * which is fine in one gan with four people and is not fine at forty.
 */
async function mayEdit(user, classroomId) {
  if (isManager(user)) return true;
  if (!classroomId || !mongoose.isValidObjectId(classroomId)) return false;

  const room = await Classroom.findById(classroomId)
    .select('lead_teacher_id gantt_editor_ids').lean();
  if (!room) return false;

  const allowed = [room.lead_teacher_id, ...(room.gantt_editor_ids || [])]
    .filter(Boolean).map(String);
  return allowed.includes(String(user?.id));
}

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

    // Whose work this is, and whether the person looking at it may change it.
    if (gantt.updated_by) {
      const who = await User.findById(gantt.updated_by).select('full_name').lean();
      gantt.updated_by_name = who?.full_name || '';
    }

    gantt.id = gantt._id;
    res.json({
      gantt,
      can_edit: await mayEdit(req.user, classroom),
      holidays: holidays.map(h => ({ ...h, id: h._id })),
    });
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

    if (!await mayEdit(req.user, classroom_id)) {
      return res.status(403).json({ error: 'אין לך הרשאה לערוך את תוכנית העבודה של הכיתה הזו' });
    }

    let gantt = await GanttMonth.findOne({
      classroom_id, month: parseInt(month), year: parseInt(year),
    });

    if (gantt) {
      /**
       * Somebody else saved while this screen was open.
       *
       * The save replaces the whole month, so without this the second person
       * to press שמור silently deletes everything the first one wrote. The
       * client sends the updated_at it loaded; if the stored one has moved,
       * the save is refused and the screen is told who moved it. `force` is
       * the deliberate "yes, mine wins" — a decision, taken by a person,
       * rather than a race nobody knew they were in.
       */
      const base = req.body.base_updated_at;
      if (base && !req.body.force && gantt.updated_at
          && new Date(gantt.updated_at).getTime() > new Date(base).getTime()) {
        const who = gantt.updated_by
          ? await User.findById(gantt.updated_by).select('full_name').lean()
          : null;
        return res.status(409).json({
          error: 'התוכנית שונתה מאז שפתחת אותה',
          conflict: true,
          updated_by: who?.full_name || '',
          updated_at: gantt.updated_at,
        });
      }

      if (row_definitions) gantt.row_definitions = row_definitions;
      if (weeks) gantt.weeks = normalizeWeeks(weeks);
      if (status) gantt.status = status;
      gantt.updated_by = req.user?.id || null;
      await gantt.save();
    } else {
      /**
       * Both of these are required by the model, and a save that arrives
       * without them used to 500 — which tells the gananet nothing and looks
       * like the system is broken. They are both derivable: the branch from
       * the room, the year from the month, exactly as `get` already does it.
       */
      let branchId = (branch_id && mongoose.isValidObjectId(branch_id)) ? branch_id : null;
      if (!branchId) {
        const room = await Classroom.findById(classroom_id).select('branch_id').lean();
        branchId = room?.branch_id || null;
      }
      if (!branchId) {
        return res.status(400).json({ error: 'לכיתה הזו אין סניף, ולכן אי אפשר לשמור לה תוכנית עבודה' });
      }

      const m = parseInt(month);
      const y = parseInt(year);
      gantt = await GanttMonth.create({
        branch_id: branchId,
        classroom_id,
        academic_year: academic_year || academicYearFor(m, y),
        month: parseInt(month),
        year: parseInt(year),
        row_definitions: row_definitions || DEFAULT_ROWS,
        weeks: weeks ? normalizeWeeks(weeks) : generateWeeks(parseInt(month), parseInt(year)),
        status: status || 'draft',
        updated_by: req.user?.id || null,
      });
    }

    res.json({ gantt: { ...gantt.toObject(), id: gantt._id } });
  } catch (error) { next(error); }
}

async function approve(req, res, next) {
  try {
    const gantt = await GanttMonth.findById(req.params.id);
    if (!gantt) return res.status(404).json({ error: 'גאנט לא נמצא' });

    // Approving is the manager's signature, not the planner's. A lead who
    // could approve her own month would make the approval step decorative.
    if (!isManager(req.user)) {
      return res.status(403).json({ error: 'אישור תוכנית עבודה הוא בסמכות מנהלת' });
    }

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


/**
 * POST /api/gantt/copy
 *   { from: {classroom, month, year}, to: {classroom, month, year},
 *     overwrite?: bool, weeks?: [index] }
 *
 * Every branch writes the same month three times — תינוקייה, צעירים, בוגרים —
 * and the three are mostly the same plan with the activities pitched
 * differently. Writing it out twice more, by hand, is the largest single piece
 * of typing left in the job, and it is the reason the ganenet stayed in Excel:
 * there you copy a sheet.
 *
 * Copied BY POSITION, not by date: week 1 to week 1, ראשון to ראשון. That is
 * what "the same plan" means to the person asking — the subject of the second
 * week is the subject of the second week — and it is the only rule that
 * survives September having five weeks and October four.
 *
 * One thing is never copied: a day the TARGET branch is closed. The two gans
 * keep different holiday calendars, and a plan landing on a day nobody is in
 * the building is how a copied month stops being trusted.
 *
 * Days the week borrows from the neighbouring month ARE copied. They are part
 * of that week and the editor lets her write them, so a copy that refused them
 * would leave holes in exactly the boxes she can fill by hand.
 */
async function copy(req, res, next) {
  try {
    const { from, to, overwrite } = req.body || {};
    if (!from?.classroom || !to?.classroom || !to.month || !to.year) {
      return res.status(400).json({ error: 'יש לבחור מקור ויעד' });
    }
    if (!await mayEdit(req.user, to.classroom)) {
      return res.status(403).json({ error: 'אין לך הרשאה לערוך את תוכנית העבודה של כיתת היעד' });
    }

    const source = await GanttMonth.findOne({
      classroom_id: from.classroom,
      month: parseInt(from.month),
      year: parseInt(from.year),
    }).lean();
    if (!source) return res.status(404).json({ error: 'לא נמצאה תוכנית במקור' });

    const targetMonth = parseInt(to.month);
    const targetYear = parseInt(to.year);

    let target = await GanttMonth.findOne({
      classroom_id: to.classroom, month: targetMonth, year: targetYear,
    });

    const room = await Classroom.findById(to.classroom).select('branch_id').lean();
    if (!target) {
      target = new GanttMonth({
        branch_id: room?.branch_id || null,
        classroom_id: to.classroom,
        academic_year: to.academic_year || academicYearFor(targetMonth, targetYear),
        month: targetMonth,
        year: targetYear,
        row_definitions: source.row_definitions || DEFAULT_ROWS,
        weeks: generateWeeks(targetMonth, targetYear),
        status: 'draft',
      });
    }

    // The target branch's own closures, which are not the source's.
    const holidays = room?.branch_id ? await Holiday.find({
      branch_id: room.branch_id,
      start_date: { $lte: new Date(targetYear, targetMonth, 0) },
      end_date: { $gte: new Date(targetYear, targetMonth - 1, 1) },
    }).lean() : [];
    const ymdOf = (d) => new Date(d).toISOString().slice(0, 10);
    const closedOn = (d) => holidays.some(h => (
      h.kind !== 'short_day' && ymdOf(d) >= ymdOf(h.start_date) && ymdOf(d) <= ymdOf(h.end_date)
    ));

    const srcWeeks = normalizeWeeks(source.weeks || []);
    const dstWeeks = normalizeWeeks(target.weeks && target.weeks.length
      ? target.weeks : generateWeeks(targetMonth, targetYear));

    const wanted = Array.isArray(req.body.weeks) && req.body.weeks.length
      ? new Set(req.body.weeks.map(Number)) : null;

    let copied = 0; let kept = 0; let skipped = 0;

    const merged = dstWeeks.map((dst, i) => {
      const src = srcWeeks[i];
      if (!src || (wanted && !wanted.has(i))) return dst;

      const sunday = new Date(dst.start_date);
      const cells = [...(dst.cells || [])];

      for (const c of (src.cells || [])) {
        const day = new Date(sunday);
        day.setDate(day.getDate() + c.day_index);
        if (closedOn(day)) { skipped += 1; continue; }
        if (!String(c.content || '').trim()) continue;

        const at = cells.findIndex(x => x.row_key === c.row_key && x.day_index === c.day_index);
        if (at >= 0 && String(cells[at].content || '').trim() && !overwrite) { kept += 1; continue; }

        const next = {
          row_key: c.row_key, day_index: c.day_index,
          content: c.content, color: c.color || '',
          col_span: c.col_span || 1, row_span: c.row_span || 1,
        };
        if (at >= 0) cells[at] = next; else cells.push(next);
        copied += 1;
      }

      return {
        ...dst,
        cells,
        // The subject is the point of the week; carry it unless the target
        // already has one of its own.
        topic: (String(dst.topic || '').trim() && !overwrite) ? dst.topic : (src.topic || dst.topic || ''),
      };
    });

    target.weeks = merged;
    if (!target.row_definitions?.length) target.row_definitions = source.row_definitions || DEFAULT_ROWS;
    target.updated_by = req.user?.id || null;
    // A copy lands as a draft. It is a starting point somebody still has to
    // read, and an approved month that changed under the approval is a lie.
    target.status = 'draft';
    await target.save();

    res.json({
      copied, kept, skipped,
      weeks: Math.min(srcWeeks.length, dstWeeks.length),
      gantt: { ...target.toObject(), id: target._id },
    });
  } catch (error) { next(error); }
}

/**
 * GET /api/gantt/sources?month=&year=
 * The months that actually have something in them, to copy FROM.
 */
async function sources(req, res, next) {
  try {
    const filter = {};
    if (req.query.month) filter.month = parseInt(req.query.month);
    if (req.query.year) filter.year = parseInt(req.query.year);

    const rows = await GanttMonth.find(filter)
      .select('classroom_id branch_id month year status weeks updated_at')
      .populate('classroom_id', 'name category')
      .populate('branch_id', 'name')
      .sort({ year: -1, month: -1 })
      .lean();

    res.json({
      sources: rows
        .map(g => ({
          id: g._id,
          classroom_id: g.classroom_id?._id || g.classroom_id,
          classroom_name: g.classroom_id?.name || '',
          category: g.classroom_id?.category || '',
          branch_name: g.branch_id?.name || '',
          month: g.month,
          year: g.year,
          status: g.status,
          filled: (g.weeks || []).reduce((n, w) => (
            n + (w.cells || []).filter(c => String(c.content || '').trim()).length
          ), 0),
        }))
        // A month with nothing written in it is not a source anybody wants.
        .filter(s => s.filled > 0),
    });
  } catch (error) { next(error); }
}

/**
 * GET /api/gantt/shabbat-parents?classroom=&month=&year=
 *
 * Who is waiting for a turn as אבא / אמא של שבת, and who to put on the weeks
 * of this month.
 *
 * The round is read back out of the plans themselves — every Friday already
 * records the two names — rather than kept as a counter somewhere. A counter
 * drifts the first time an old month is edited or a child leaves in March; the
 * plans are the record, so the plans are what is counted.
 */
async function shabbatParents(req, res, next) {
  try {
    const { classroom, month, year } = req.query;
    if (!classroom || !mongoose.isValidObjectId(classroom)) {
      return res.status(400).json({ error: 'יש לבחור כיתה' });
    }

    const room = await Classroom.findById(classroom).select('academic_year').lean();
    const academicYear = room?.academic_year || '';

    const kids = await Child.find({
      classroom_id: classroom, is_active: true,
      ...(academicYear ? { academic_year: academicYear } : {}),
    }).select('child_name gender registration_id').sort({ child_name: 1 }).lean();

    /**
     * A child imported from ClickTac already told us. In the אמונה / תמ״ת
     * branches the whole roster arrives through the ministry list and
     * ClickTac, and ClickTac's export carries מגדר — it was being written into
     * the registration and not onto the child. Read from there when the child
     * has none of its own, so nobody is asked to re-enter seventy-four facts
     * the system was handed.
     *
     * Read, not written: what the gan sets by hand on the child always wins,
     * and a GET is not a place to quietly rewrite records.
     */
    const needGender = kids.filter(c => !c.gender && c.registration_id);
    const fromImport = new Map();
    if (needGender.length) {
      const regs = await Registration.find({ _id: { $in: needGender.map(c => c.registration_id) } })
        .select('configuration').lean();
      for (const r of regs) {
        const g = shabbat.normalizeGender(r.configuration?.external_source?.gender);
        if (g) fromImport.set(String(r._id), g);
      }
    }

    const children = kids.map(c => ({
      id: String(c._id),
      name: c.child_name,
      gender: c.gender || fromImport.get(String(c.registration_id)) || '',
    }));

    // Every Friday this room has ever been assigned, oldest first. A week is
    // dated by its own start, so months edited out of order still count in
    // the order the weeks actually happened.
    const months = await GanttMonth.find({ classroom_id: classroom })
      .select('weeks month year').lean();

    const history = months
      .flatMap(m => (m.weeks || []).map(w => ({
        date: w.start_date,
        father_child_id: w.friday_father_child_id ? String(w.friday_father_child_id) : null,
        mother_child_id: w.friday_mother_child_id ? String(w.friday_mother_child_id) : null,
      })))
      .filter(t => t.father_child_id || t.mother_child_id)
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    const state = shabbat.rotation(children, history);

    // A proposal for this month, if one was asked for.
    let plan = null;
    if (month && year) {
      const doc = months.find(m => m.month === parseInt(month) && m.year === parseInt(year));
      const weeks = normalizeWeeks(doc?.weeks?.length
        ? doc.weeks : generateWeeks(parseInt(month), parseInt(year)));
      plan = shabbat.planMonth(state, weeks.map((w, i) => ({
        index: i,
        has_father: Boolean(String(w.friday_parent_father || '').trim()),
        has_mother: Boolean(String(w.friday_parent_mother || '').trim()),
      })));
    }

    res.json({ ...state, plan });
  } catch (error) { next(error); }
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
  get, save, approve, getArchive, copy, sources, shabbatParents,
  getVisibility, setVisibility,
  generateWeeks, normalizeWeeks, DEFAULT_ROWS,
};
