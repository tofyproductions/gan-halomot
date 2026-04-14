const { Activity } = require('../models');
const { getBranchFilter } = require('../utils/branch-filter');

async function getAll(req, res, next) {
  try {
    const filter = { is_active: true, ...getBranchFilter(req) };
    const activities = await Activity.find(filter).sort({ name: 1 }).lean();
    res.json({ activities: activities.map(a => ({ ...a, id: a._id })) });
  } catch (error) { next(error); }
}

async function create(req, res, next) {
  try {
    const { branch_id, name, color, fixed_day, target_row } = req.body;
    if (!name) return res.status(400).json({ error: 'שם החוג חובה' });
    const activity = await Activity.create({
      branch_id: branch_id || req.query.branch,
      name, color: color || '#dbeafe',
      fixed_day: fixed_day != null ? fixed_day : null,
      target_row: target_row || 'misc',
    });
    res.status(201).json({ activity: { ...activity.toObject(), id: activity._id } });
  } catch (error) { next(error); }
}

async function update(req, res, next) {
  try {
    const a = await Activity.findById(req.params.id);
    if (!a) return res.status(404).json({ error: 'חוג לא נמצא' });
    ['name', 'color', 'fixed_day', 'target_row'].forEach(f => {
      if (req.body[f] !== undefined) a[f] = req.body[f];
    });
    await a.save();
    res.json({ activity: { ...a.toObject(), id: a._id } });
  } catch (error) { next(error); }
}

async function remove(req, res, next) {
  try {
    await Activity.findByIdAndUpdate(req.params.id, { is_active: false });
    res.json({ message: 'חוג הוסר' });
  } catch (error) { next(error); }
}

module.exports = { getAll, create, update, remove };
