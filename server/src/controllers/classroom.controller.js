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

async function create(req, res, next) {
  try {
    const { name, academic_year, capacity, category } = req.body;
    if (!name || !academic_year) {
      return res.status(400).json({ error: 'name and academic_year are required' });
    }

    if (category && !Classroom.CATEGORIES.includes(category)) {
      return res.status(400).json({ error: 'invalid category' });
    }

    const { branch_id } = req.body;
    const normalizedYear = normalizeYear(academic_year);
    const existing = await Classroom.findOne({ name, academic_year: normalizedYear, branch_id: branch_id || null });
    if (existing) {
      return res.status(409).json({ error: 'כיתה עם שם זה כבר קיימת בסניף לשנה זו' });
    }

    const classroom = await Classroom.create({
      name,
      category: category || null,
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

    if (updates.category !== undefined && updates.category !== null && !Classroom.CATEGORIES.includes(updates.category)) {
      return res.status(400).json({ error: 'invalid category' });
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
