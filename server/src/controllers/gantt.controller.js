const { GanttMonth, Holiday } = require('../models');

const DEFAULT_ROWS = [
  { key: 'meeting', label: 'מפגש' },
  { key: 'activity', label: 'פעילות' },
  { key: 'story', label: 'סיפור' },
  { key: 'misc', label: 'שונות' },
];

async function get(req, res, next) {
  try {
    const { branch, classroom, month, year } = req.query;
    if (!classroom || !month || !year) {
      return res.status(400).json({ error: 'classroom, month, year required' });
    }

    let gantt = await GanttMonth.findOne({
      classroom_id: classroom,
      month: parseInt(month),
      year: parseInt(year),
    }).populate('approved_by', 'full_name').lean();

    // If not found, return empty template with weeks
    if (!gantt) {
      const branchId = branch || req.query.branch;
      gantt = {
        _id: null,
        branch_id: branchId,
        classroom_id: classroom,
        month: parseInt(month),
        year: parseInt(year),
        status: 'draft',
        row_definitions: DEFAULT_ROWS,
        weeks: generateWeeks(parseInt(month), parseInt(year)),
        approved_by: null,
        approved_at: null,
      };
    }

    // Get holidays for this month
    const startOfMonth = new Date(parseInt(year), parseInt(month) - 1, 1);
    const endOfMonth = new Date(parseInt(year), parseInt(month), 0);

    const holidays = await Holiday.find({
      branch_id: gantt.branch_id,
      start_date: { $lte: endOfMonth },
      end_date: { $gte: startOfMonth },
    }).lean();

    gantt.id = gantt._id;
    res.json({ gantt, holidays: holidays.map(h => ({ ...h, id: h._id })) });
  } catch (error) { next(error); }
}

async function save(req, res, next) {
  try {
    const {
      branch_id, classroom_id, academic_year,
      month, year, row_definitions, weeks, status,
    } = req.body;

    if (!classroom_id || !month || !year) {
      return res.status(400).json({ error: 'classroom_id, month, year required' });
    }

    let gantt = await GanttMonth.findOne({
      classroom_id, month: parseInt(month), year: parseInt(year),
    });

    if (gantt) {
      // Update existing
      if (row_definitions) gantt.row_definitions = row_definitions;
      if (weeks) gantt.weeks = weeks;
      if (status) gantt.status = status;
      await gantt.save();
    } else {
      // Create new
      gantt = await GanttMonth.create({
        branch_id,
        classroom_id,
        academic_year: academic_year || '',
        month: parseInt(month),
        year: parseInt(year),
        row_definitions: row_definitions || DEFAULT_ROWS,
        weeks: weeks || generateWeeks(parseInt(month), parseInt(year)),
        status: status || 'draft',
      });
    }

    res.json({ gantt: { ...gantt.toObject(), id: gantt._id } });
  } catch (error) { next(error); }
}

async function approve(req, res, next) {
  try {
    const gantt = await GanttMonth.findById(req.params.id);
    if (!gantt) return res.status(404).json({ error: 'גאנט לא נמצא' });

    gantt.status = 'approved';
    gantt.approved_by = req.user?.id || null;
    gantt.approved_at = new Date();
    await gantt.save();

    res.json({ message: 'גאנט אושר', gantt: { ...gantt.toObject(), id: gantt._id } });
  } catch (error) { next(error); }
}

async function getArchive(req, res, next) {
  try {
    const { classroom, branch } = req.query;
    const filter = {};
    if (classroom) filter.classroom_id = classroom;
    if (branch) filter.branch_id = branch;

    const gantts = await GanttMonth.find(filter)
      .select('classroom_id month year status approved_at')
      .populate('classroom_id', 'name')
      .sort({ year: -1, month: -1 })
      .lean();

    res.json({
      archive: gantts.map(g => ({
        ...g, id: g._id,
        classroom_name: g.classroom_id?.name || '',
      })),
    });
  } catch (error) { next(error); }
}

// Generate week structure for a month
function generateWeeks(month, year) {
  const weeks = [];
  const firstDay = new Date(year, month - 1, 1);
  const lastDay = new Date(year, month, 0);

  let current = new Date(firstDay);
  // Find first Sunday
  while (current.getDay() !== 0 && current <= lastDay) {
    current.setDate(current.getDate() + 1);
  }
  // Include partial first week if month starts mid-week
  if (firstDay.getDay() !== 0) {
    const weekStart = new Date(firstDay);
    const weekEnd = new Date(current);
    weekEnd.setDate(weekEnd.getDate() - 1);
    if (weekEnd >= weekStart) {
      weeks.push({
        week_number: 1,
        start_date: weekStart,
        end_date: weekEnd > lastDay ? lastDay : weekEnd,
        topic: '',
        cells: [],
        friday_parent_father: '',
        friday_parent_mother: '',
      });
    }
  }

  let weekNum = weeks.length + 1;
  while (current <= lastDay) {
    const weekStart = new Date(current);
    const weekEnd = new Date(current);
    weekEnd.setDate(weekEnd.getDate() + 5); // Sun-Fri

    weeks.push({
      week_number: weekNum++,
      start_date: weekStart,
      end_date: weekEnd > lastDay ? lastDay : weekEnd,
      topic: '',
      cells: [],
      friday_parent_father: '',
      friday_parent_mother: '',
    });

    current.setDate(current.getDate() + 7);
  }

  return weeks;
}

module.exports = { get, save, approve, getArchive };
