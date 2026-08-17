const { Classroom, Child } = require('../models');
const { normalizeYear, getAcademicYears } = require('../services/academic-year.service');
const { getBranchFilter } = require('../utils/branch-filter');

async function getAll(req, res, next) {
  try {
    const { year } = req.query;
    const academicYears = getAcademicYears();
    const targetYear = year ? normalizeYear(year) : academicYears.current.range;

    const branchFilter = getBranchFilter(req);
    const classrooms = await Classroom.find({ is_active: true, ...branchFilter })
      .populate('lead_teacher_id', 'full_name')
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

module.exports = { getAll, create, update, remove, cleanupGarbled };
