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

    // Paging, on the same terms as the employees list: only when asked for, so
    // a gan keeps getting its whole class and nothing is ever silently cut —
    // a child missing from a list reads as a child who left. `total` is
    // returned either way so a network's client can discover it should page.
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : null;
    const page = Math.max(1, Number(req.query.page) || 1);

    const q = String(req.query.q || '').trim();
    if (q) {
      const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.child_name = { $regex: safe, $options: 'i' };
    }

    const total = await Child.countDocuments(filter);

    // Same ceiling as the employees list, and for the same reason: everything
    // is right for a gan and fatal for a network. Refusing names the number and
    // the way to ask again, rather than sending 80,000 rows to a browser that
    // cannot draw them.
    const MAX_UNPAGED = Number(process.env.LIST_MAX_UNPAGED || 5000);
    if (!limit && total > MAX_UNPAGED) {
      return res.status(413).json({
        error: `${total.toLocaleString('he-IL')} ילדים הם יותר מדי להצגה בבת אחת.`,
        hint: 'בחרו סניף או כיתה, חפשו, או בקשו עמוד (limit ו-page).',
        total,
        max_unpaged: MAX_UNPAGED,
      });
    }

    let query = Child.find(filter)
      .populate('classroom_id', 'name capacity')
      .sort({ child_name: 1 });
    if (limit) query = query.skip((page - 1) * limit).limit(limit);
    const children = await query.lean();

    const result = children.map(c => ({
      ...c,
      id: c._id,
      classroom_name: c.classroom_id?.name || null,
      classroom_capacity: c.classroom_id?.capacity || null,
      classroom_id: c.classroom_id?._id || c.classroom_id,
    }));

    res.json({
      children: result,
      total,
      page: limit ? page : 1,
      limit: limit || total,
      has_more: limit ? page * limit < total : false,
    });
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
