const db = require('../config/database');
const { normalizeYear, getAcademicYears } = require('../services/academic-year.service');

/**
 * GET /api/classroom?year=2025
 * Return classrooms with child count for the given academic year
 */
async function getAll(req, res, next) {
  try {
    const { year } = req.query;
    const academicYears = getAcademicYears();
    const targetYear = year
      ? normalizeYear(year)
      : academicYears.current.range;

    const classrooms = await db('classrooms')
      .select('classrooms.*')
      .where('classrooms.is_active', true)
      .orderBy('classrooms.name');

    // Get child counts per classroom for the target year
    const childCounts = await db('children')
      .select('classroom_id')
      .count('id as child_count')
      .where('is_active', true)
      .andWhere('academic_year', targetYear)
      .groupBy('classroom_id');

    const countMap = {};
    for (const row of childCounts) {
      countMap[row.classroom_id] = parseInt(row.child_count);
    }

    const result = classrooms.map(c => ({
      ...c,
      child_count: countMap[c.id] || 0,
    }));

    res.json({ classrooms: result });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/classroom
 * Create a new classroom
 */
async function create(req, res, next) {
  try {
    const { name, academic_year, capacity } = req.body;

    if (!name || !academic_year) {
      return res.status(400).json({ error: 'name and academic_year are required' });
    }

    // Check for duplicate name+year
    const existing = await db('classrooms')
      .where({ name, academic_year: normalizeYear(academic_year) })
      .first();

    if (existing) {
      return res.status(409).json({ error: 'A classroom with this name already exists for this academic year' });
    }

    const [classroom] = await db('classrooms')
      .insert({
        name,
        academic_year: normalizeYear(academic_year),
        capacity: capacity || null,
      })
      .returning('*');

    res.status(201).json({ classroom });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/classroom/:id
 * Update classroom details
 */
async function update(req, res, next) {
  try {
    const { id } = req.params;
    const updates = req.body;

    const existing = await db('classrooms').where({ id }).first();
    if (!existing) {
      return res.status(404).json({ error: 'Classroom not found' });
    }

    // Remove non-updatable fields
    delete updates.id;
    delete updates.created_at;

    if (updates.academic_year) {
      updates.academic_year = normalizeYear(updates.academic_year);
    }

    await db('classrooms').where({ id }).update(updates);

    const updated = await db('classrooms').where({ id }).first();

    res.json({ classroom: updated });
  } catch (error) {
    next(error);
  }
}

module.exports = { getAll, create, update };
