const { Classroom, Child } = require('../models');
const { normalizeYear, getAcademicYears } = require('../services/academic-year.service');
const { getBranchFilter } = require('../utils/branch-filter');

async function getAll(req, res, next) {
  try {
    const { year } = req.query;
    const academicYears = getAcademicYears();
    const targetYear = year ? normalizeYear(year) : academicYears.current.range;

    const branchFilter = getBranchFilter(req);
    const classrooms = await Classroom.find({ is_active: true, ...branchFilter }).sort({ name: 1 }).lean();

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
    }));

    res.json({ classrooms: result });
  } catch (error) {
    next(error);
  }
}

async function create(req, res, next) {
  try {
    const { name, academic_year, capacity } = req.body;
    if (!name || !academic_year) {
      return res.status(400).json({ error: 'name and academic_year are required' });
    }

    const normalizedYear = normalizeYear(academic_year);
    const existing = await Classroom.findOne({ name, academic_year: normalizedYear });
    if (existing) {
      return res.status(409).json({ error: 'A classroom with this name already exists for this academic year' });
    }

    const classroom = await Classroom.create({
      name,
      academic_year: normalizedYear,
      capacity: capacity || null,
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

    const updated = await Classroom.findByIdAndUpdate(id, updates, { new: true }).lean();
    updated.id = updated._id;

    res.json({ classroom: updated });
  } catch (error) {
    next(error);
  }
}

module.exports = { getAll, create, update };
