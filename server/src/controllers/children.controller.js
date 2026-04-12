const { Child, Registration, Classroom } = require('../models');
const { normalizeYear, getAcademicYears } = require('../services/academic-year.service');

async function getAll(req, res, next) {
  try {
    const { classroom_id, year } = req.query;
    const academicYears = getAcademicYears();

    const filter = { is_active: true };

    if (year) {
      filter.academic_year = normalizeYear(year);
    } else {
      filter.academic_year = academicYears.current.range;
    }

    if (classroom_id) {
      filter.classroom_id = classroom_id;
    }

    const children = await Child.find(filter)
      .populate('classroom_id', 'name capacity')
      .sort({ child_name: 1 })
      .lean();

    const result = children.map(c => ({
      ...c,
      id: c._id,
      classroom_name: c.classroom_id?.name || null,
      classroom_capacity: c.classroom_id?.capacity || null,
      classroom_id: c.classroom_id?._id || c.classroom_id,
    }));

    res.json({ children: result });
  } catch (error) {
    next(error);
  }
}

async function getById(req, res, next) {
  try {
    const { id } = req.params;
    const child = await Child.findById(id).populate('classroom_id', 'name').lean();
    if (!child) {
      return res.status(404).json({ error: 'Child not found' });
    }

    child.id = child._id;
    child.classroom_name = child.classroom_id?.name || null;
    child.classroom_id = child.classroom_id?._id || child.classroom_id;

    let registration = null;
    if (child.registration_id) {
      registration = await Registration.findById(child.registration_id).lean();
      if (registration) registration.id = registration._id;
    }

    res.json({ child, registration });
  } catch (error) {
    next(error);
  }
}

async function update(req, res, next) {
  try {
    const { id } = req.params;
    const updates = req.body;

    delete updates._id;
    delete updates.id;
    delete updates.created_at;

    const existing = await Child.findById(id);
    if (!existing) {
      return res.status(404).json({ error: 'Child not found' });
    }

    const updated = await Child.findByIdAndUpdate(id, updates, { new: true })
      .populate('classroom_id', 'name').lean();

    updated.id = updated._id;
    updated.classroom_name = updated.classroom_id?.name || null;
    updated.classroom_id = updated.classroom_id?._id || updated.classroom_id;

    res.json({ child: updated });
  } catch (error) {
    next(error);
  }
}

async function updateClassroom(req, res, next) {
  try {
    const { id } = req.params;
    const { classroom_id } = req.body;

    if (!classroom_id) {
      return res.status(400).json({ error: 'classroom_id is required' });
    }

    const child = await Child.findById(id);
    if (!child) {
      return res.status(404).json({ error: 'Child not found' });
    }

    const classroom = await Classroom.findById(classroom_id);
    if (!classroom) {
      return res.status(404).json({ error: 'Classroom not found' });
    }

    child.classroom_id = classroom_id;
    await child.save();

    if (child.registration_id) {
      await Registration.findByIdAndUpdate(child.registration_id, { classroom_id });
    }

    const updated = await Child.findById(id).populate('classroom_id', 'name').lean();
    updated.id = updated._id;
    updated.classroom_name = updated.classroom_id?.name || null;
    updated.classroom_id = updated.classroom_id?._id || updated.classroom_id;

    res.json({ child: updated });
  } catch (error) {
    next(error);
  }
}

async function remove(req, res, next) {
  try {
    const { id } = req.params;
    const child = await Child.findById(id);
    if (!child) {
      return res.status(404).json({ error: 'Child not found' });
    }

    child.is_active = false;
    await child.save();

    res.json({ message: 'Child deactivated successfully', id });
  } catch (error) {
    next(error);
  }
}

module.exports = { getAll, getById, update, updateClassroom, remove };
