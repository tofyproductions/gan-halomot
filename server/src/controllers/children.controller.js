const db = require('../config/database');
const { normalizeYear, getAcademicYears } = require('../services/academic-year.service');

/**
 * GET /api/children?classroom_id=1&year=2025
 * Return all children, optionally filtered by classroom and academic year
 */
async function getAll(req, res, next) {
  try {
    const { classroom_id, year } = req.query;
    const academicYears = getAcademicYears();

    let query = db('children')
      .select(
        'children.*',
        'classrooms.name as classroom_name',
        'classrooms.capacity as classroom_capacity'
      )
      .leftJoin('classrooms', 'children.classroom_id', 'classrooms.id')
      .where('children.is_active', true);

    if (year) {
      query = query.andWhere('children.academic_year', normalizeYear(year));
    } else {
      query = query.andWhere('children.academic_year', academicYears.current.range);
    }

    if (classroom_id) {
      query = query.andWhere('children.classroom_id', classroom_id);
    }

    const children = await query.orderBy('children.child_name');

    res.json({ children });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/children/:id
 * Return a single child with registration data
 */
async function getById(req, res, next) {
  try {
    const { id } = req.params;

    const child = await db('children')
      .select(
        'children.*',
        'classrooms.name as classroom_name'
      )
      .leftJoin('classrooms', 'children.classroom_id', 'classrooms.id')
      .where('children.id', id)
      .first();

    if (!child) {
      return res.status(404).json({ error: 'Child not found' });
    }

    let registration = null;
    if (child.registration_id) {
      registration = await db('registrations')
        .where({ id: child.registration_id })
        .first();
    }

    res.json({ child, registration });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/children/:id
 * Update child record
 */
async function update(req, res, next) {
  try {
    const { id } = req.params;
    const updates = req.body;

    // Remove fields that should not be directly updated
    delete updates.id;
    delete updates.created_at;

    const existing = await db('children').where({ id }).first();
    if (!existing) {
      return res.status(404).json({ error: 'Child not found' });
    }

    updates.updated_at = new Date();

    await db('children').where({ id }).update(updates);

    const updated = await db('children')
      .select('children.*', 'classrooms.name as classroom_name')
      .leftJoin('classrooms', 'children.classroom_id', 'classrooms.id')
      .where('children.id', id)
      .first();

    res.json({ child: updated });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/children/:id/classroom
 * Update child's classroom and also update the linked registration
 */
async function updateClassroom(req, res, next) {
  try {
    const { id } = req.params;
    const { classroom_id } = req.body;

    if (!classroom_id) {
      return res.status(400).json({ error: 'classroom_id is required' });
    }

    const child = await db('children').where({ id }).first();
    if (!child) {
      return res.status(404).json({ error: 'Child not found' });
    }

    const classroom = await db('classrooms').where({ id: classroom_id }).first();
    if (!classroom) {
      return res.status(404).json({ error: 'Classroom not found' });
    }

    await db('children').where({ id }).update({
      classroom_id,
      updated_at: new Date(),
    });

    // Also update linked registration if exists
    if (child.registration_id) {
      await db('registrations')
        .where({ id: child.registration_id })
        .update({
          classroom_id,
          updated_at: new Date(),
        });
    }

    const updated = await db('children')
      .select('children.*', 'classrooms.name as classroom_name')
      .leftJoin('classrooms', 'children.classroom_id', 'classrooms.id')
      .where('children.id', id)
      .first();

    res.json({ child: updated });
  } catch (error) {
    next(error);
  }
}

/**
 * DELETE /api/children/:id
 * Soft delete - set is_active = false
 */
async function remove(req, res, next) {
  try {
    const { id } = req.params;

    const child = await db('children').where({ id }).first();
    if (!child) {
      return res.status(404).json({ error: 'Child not found' });
    }

    await db('children').where({ id }).update({
      is_active: false,
      updated_at: new Date(),
    });

    res.json({ message: 'Child deactivated successfully', id: parseInt(id) });
  } catch (error) {
    next(error);
  }
}

module.exports = { getAll, getById, update, updateClassroom, remove };
