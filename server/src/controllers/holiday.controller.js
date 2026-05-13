const { Holiday } = require('../models');
const { getBranchFilter } = require('../utils/branch-filter');

async function getAll(req, res, next) {
  try {
    const { year } = req.query;
    const filter = { ...getBranchFilter(req) };
    if (year) filter.academic_year = year;

    const holidays = await Holiday.find(filter)
      .populate('branch_id', 'name')
      .sort({ start_date: 1 })
      .lean();

    res.json({ holidays: holidays.map(h => ({ ...h, id: h._id })) });
  } catch (error) { next(error); }
}

async function create(req, res, next) {
  try {
    const { branch_id, academic_year, name, start_date, end_date, is_custom, is_half_day, end_time } = req.body;
    if (!branch_id || !name || !start_date || !end_date) {
      return res.status(400).json({ error: 'שדות חובה חסרים' });
    }

    const holiday = await Holiday.create({
      branch_id, academic_year: academic_year || '',
      name, start_date, end_date,
      is_custom: is_custom || false,
      is_half_day: !!is_half_day,
      end_time: is_half_day ? (end_time || '12:00') : '',
    });

    res.status(201).json({ holiday: { ...holiday.toObject(), id: holiday._id } });
  } catch (error) { next(error); }
}

async function update(req, res, next) {
  try {
    const holiday = await Holiday.findById(req.params.id);
    if (!holiday) return res.status(404).json({ error: 'חופשה לא נמצאה' });

    ['name', 'start_date', 'end_date'].forEach(f => {
      if (req.body[f] !== undefined) holiday[f] = req.body[f];
    });
    if (req.body.is_half_day !== undefined) holiday.is_half_day = !!req.body.is_half_day;
    if (req.body.end_time !== undefined) holiday.end_time = req.body.end_time || '';
    // Clear end_time when flag is turned off
    if (!holiday.is_half_day) holiday.end_time = '';
    // Default end_time when turning flag on without explicit time
    if (holiday.is_half_day && !holiday.end_time) holiday.end_time = '12:00';
    await holiday.save();

    res.json({ holiday: { ...holiday.toObject(), id: holiday._id } });
  } catch (error) { next(error); }
}

async function remove(req, res, next) {
  try {
    await Holiday.findByIdAndDelete(req.params.id);
    res.json({ message: 'חופשה נמחקה' });
  } catch (error) { next(error); }
}

async function copyFromBranch(req, res, next) {
  try {
    const { source_branch_id, target_branch_id, academic_year } = req.body;
    if (!source_branch_id || !target_branch_id) {
      return res.status(400).json({ error: 'source and target branch required' });
    }

    const sourceHolidays = await Holiday.find({
      branch_id: source_branch_id,
      academic_year: academic_year || '',
    }).lean();

    if (sourceHolidays.length === 0) {
      return res.status(404).json({ error: 'אין חופשות בסניף המקור' });
    }

    // Delete existing holidays for target
    await Holiday.deleteMany({ branch_id: target_branch_id, academic_year: academic_year || '' });

    // Copy
    const copies = sourceHolidays.map(h => ({
      branch_id: target_branch_id,
      academic_year: h.academic_year,
      name: h.name,
      start_date: h.start_date,
      end_date: h.end_date,
      is_custom: h.is_custom,
      is_half_day: h.is_half_day,
      end_time: h.end_time,
    }));

    await Holiday.insertMany(copies);
    res.json({ message: `${copies.length} חופשות הועתקו`, count: copies.length });
  } catch (error) { next(error); }
}

module.exports = { getAll, create, update, remove, copyFromBranch };
