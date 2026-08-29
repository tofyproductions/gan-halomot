const { Classroom, Child, Branch } = require('../models');
const { normalizeYear, getAcademicYears } = require('../services/academic-year.service');
const planner = require('../services/classroomPlanner');
const { getBranchFilter } = require('../utils/branch-filter');

async function getAll(req, res, next) {
  try {
    const { year } = req.query;
    const academicYears = getAcademicYears();
    const targetYear = year ? normalizeYear(year) : academicYears.current.range;

    const branchFilter = getBranchFilter(req);
    const classrooms = await Classroom.find({ is_active: true, ...branchFilter })
      .populate('lead_teacher_id', 'full_name')
      // Who may write this room's monthly plan, by name, so the gantt screen
      // can show it without a second round trip per room.
      .populate('gantt_editor_ids', 'full_name')
      .sort({ name: 1 }).lean();

    // Get child counts
    const childCounts = await Child.aggregate([
      { $match: { is_active: true, academic_year: targetYear } },
      { $group: { _id: '$classroom_id', child_count: { $sum: 1 } } },
    ]);

    const countMap = {};
    for (const row of childCounts) {
      countMap[String(row._id)] = row.child_count;
    }

    const result = classrooms.map(c => ({
      ...c,
      id: c._id,
      child_count: countMap[String(c._id)] || 0,
      lead_teacher_name: c.lead_teacher_id?.full_name || null,
      lead_teacher_id: c.lead_teacher_id?._id || c.lead_teacher_id,
      gantt_editors: (c.gantt_editor_ids || []).map(u => ({
        id: u?._id || u, full_name: u?.full_name || '',
      })),
      gantt_editor_ids: (c.gantt_editor_ids || []).map(u => String(u?._id || u)),
    }));

    res.json({ classrooms: result });
  } catch (error) {
    next(error);
  }
}

/**
 * The age group is not optional, whatever the schema's default says.
 *
 * A room is matched to the children waiting for it through its category and
 * nothing else — `AGE_GROUP_TO_CATEGORY` in the placement controller maps
 * תינוק→תינוקייה, פעוט→צעירים, בוגר→בוגרים. A room with no category belongs to
 * no group, so the placement screen never lists it and no child can be put in
 * it. It is not a half-configured room; it is a room that does not exist to
 * the one screen that matters, and it fails silently: the screen shows "אין
 * כיתות לשנה זו" while the rooms sit right there in the branches screen.
 *
 * That is how this gan came to hold ten rooms for תשפ"ז and be unable to place
 * a single child into any of them. So the field is refused at the door instead.
 */
function categoryError(category) {
  if (!category) {
    return 'יש לבחור קבוצת גיל לכיתה (תינוקייה / צעירים / בוגרים). '
      + 'בלי קבוצה הכיתה לא תוצע במסך השיבוץ ואי אפשר יהיה לשבץ אליה ילדים.';
  }
  if (!Classroom.CATEGORIES.includes(category)) return 'קבוצת גיל לא תקינה';
  return null;
}

async function create(req, res, next) {
  try {
    const { name, academic_year, capacity, category } = req.body;
    if (!name || !academic_year) {
      return res.status(400).json({ error: 'name and academic_year are required' });
    }

    const catErr = categoryError(category);
    if (catErr) return res.status(400).json({ error: catErr });

    const { branch_id } = req.body;
    const normalizedYear = normalizeYear(academic_year);
    const existing = await Classroom.findOne({ name, academic_year: normalizedYear, branch_id: branch_id || null });
    if (existing) {
      return res.status(409).json({ error: 'כיתה עם שם זה כבר קיימת בסניף לשנה זו' });
    }

    const classroom = await Classroom.create({
      name,
      category,
      academic_year: normalizedYear,
      capacity: capacity || null,
      branch_id: branch_id || null,
    });

    res.status(201).json({ classroom: { ...classroom.toObject(), id: classroom._id } });
  } catch (error) {
    next(error);
  }
}

async function update(req, res, next) {
  try {
    const { id } = req.params;
    const updates = req.body;

    const existing = await Classroom.findById(id);
    if (!existing) {
      return res.status(404).json({ error: 'Classroom not found' });
    }

    delete updates._id;
    delete updates.id;
    delete updates.created_at;

    if (updates.academic_year) {
      updates.academic_year = normalizeYear(updates.academic_year);
    }

    // Clearing it counts as setting it. The dropdown on the branches screen has
    // a blank option, and choosing it used to quietly remove the room from the
    // placement screen — an edit that looks like tidying and reads, downstream,
    // as "this room no longer accepts children".
    if (updates.category !== undefined) {
      const catErr = categoryError(updates.category);
      if (catErr) return res.status(400).json({ error: catErr });
    }

    const updated = await Classroom.findByIdAndUpdate(id, updates, { new: true }).lean();
    updated.id = updated._id;

    res.json({ classroom: updated });
  } catch (error) {
    next(error);
  }
}

async function cleanupGarbled(req, res, next) {
  try {
    // Match U+FFFD replacement char or invalid sequence markers in classroom name.
    // These appear as "��" / "?" boxes in the UI.
    const garbled = await Classroom.find({ name: { $regex: /[�?]{2,}/ } });
    const ids = garbled.map(c => c._id);

    if (ids.length === 0) {
      return res.json({ deactivated: 0, items: [] });
    }

    await Classroom.updateMany({ _id: { $in: ids } }, { $set: { is_active: false } });

    res.json({
      deactivated: ids.length,
      items: garbled.map(c => ({ id: c._id, name: c.name })),
    });
  } catch (error) {
    next(error);
  }
}

async function remove(req, res, next) {
  try {
    const { id } = req.params;
    const classroom = await Classroom.findById(id);
    if (!classroom) {
      return res.status(404).json({ error: 'Classroom not found' });
    }

    // Check if classroom has active children
    const activeChildren = await Child.countDocuments({ classroom_id: id, is_active: true });
    if (activeChildren > 0) {
      return res.status(400).json({ error: `לא ניתן למחוק כיתה עם ${activeChildren} ילדים פעילים` });
    }

    classroom.is_active = false;
    await classroom.save();
    res.json({ message: 'כיתה הוסרה', id });
  } catch (error) {
    next(error);
  }
}


// ---------------------------------------------------------------------------
// פתיחת שנה — the year's classrooms, for every branch, in one press.
//
// A child absorbed with no classroom is absorbed into nothing: no rooms
// screen, no attendance, no collections, no supplies list. Until the rooms
// exist the whole intake is stuck, and creating them one dialog at a time
// across four branches and three age groups is twenty presses.
// ---------------------------------------------------------------------------

/** Which branches this request covers, honouring the caller's scope. */
async function targetBranches(req) {
  const asked = req.body?.branch_ids;
  const scope = getBranchFilter(req);
  const filter = { ...scope };
  if (Array.isArray(asked) && asked.length) filter._id = { $in: asked };
  return Branch.find(filter).select('_id name').sort({ name: 1 }).lean();
}

/**
 * Work out what would be created, per branch, without creating it.
 *
 * A preview rather than a confirmation dialog that says "are you sure": across
 * four branches this writes dozens of rows, and "sure about what" is a fair
 * question. The same function then does the writing, so the two cannot
 * disagree about what was promised.
 */
async function buildPlan(req) {
  const academicYear = normalizeYear(req.body?.academic_year || getAcademicYears().current.range);
  const mode = req.body?.mode === 'copy' ? 'copy' : 'create';
  const fromYear = req.body?.from_year ? normalizeYear(req.body.from_year) : null;

  const branches = await targetBranches(req);
  const out = [];

  for (const branch of branches) {
    const existing = await Classroom.find({
      branch_id: branch._id, academic_year: academicYear, is_active: true,
    }).select('name').lean();
    const existingNames = existing.map((r) => r.name);

    let planned;
    if (mode === 'copy') {
      const source = await Classroom.find({
        branch_id: branch._id, academic_year: fromYear, is_active: true,
      }).select('name category capacity').sort({ name: 1 }).lean();
      planned = planner.planCopy(source, existingNames);
      planned.source_count = source.length;
    } else {
      planned = planner.planCreate(existingNames, req.body?.plan);
    }

    out.push({
      branch_id: String(branch._id),
      branch_name: branch.name,
      existing_count: existingNames.length,
      ...planned,
    });
  }

  return { academic_year: academicYear, mode, from_year: fromYear, branches: out };
}

/** POST /api/classroom/bulk/preview — what would happen. */
async function bulkPreview(req, res, next) {
  try {
    res.json(await buildPlan(req));
  } catch (error) { next(error); }
}

/** POST /api/classroom/bulk — do it. */
async function bulkCreate(req, res, next) {
  try {
    const plan = await buildPlan(req);
    let total = 0;

    for (const branch of plan.branches) {
      if (!branch.create.length) continue;
      // insertMany rather than a loop of create(): one round trip per branch,
      // and `ordered: false` so one bad row cannot abandon the rest of a gan's
      // year half-open.
      const docs = branch.create.map((room) => ({
        name: room.name,
        category: room.category || null,
        capacity: room.capacity || null,
        academic_year: plan.academic_year,
        branch_id: branch.branch_id,
        is_active: true,
      }));
      try {
        const written = await Classroom.insertMany(docs, { ordered: false });
        branch.created = written.length;
        total += written.length;
      } catch (err) {
        // A duplicate that slipped in between the plan and the write is not a
        // failure — it is the thing the plan was trying to avoid, arriving
        // late. Anything else is reported on the branch rather than thrown,
        // so the branches that worked still stand.
        branch.created = err?.result?.result?.nInserted ?? 0;
        branch.error = err.message;
        total += branch.created;
      }
    }

    res.json({ ...plan, total_created: total });
  } catch (error) { next(error); }
}

module.exports = { getAll, create, update, remove, cleanupGarbled, bulkPreview, bulkCreate };
