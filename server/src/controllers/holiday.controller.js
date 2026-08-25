const { Holiday, SpecialDay, Branch } = require('../models');
const vacationCalendar = require('../services/vacationCalendar');
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

    /*
     * The year's employer closures come back too.
     *
     * They live in SpecialDay because they cost something different — nothing
     * is drawn from anybody's balance — but that is a payroll distinction, and
     * the person looking at "חופשות וחגים" is asking a calendar question: is
     * the gan open. Splitting the answer across two screens meant the import
     * wrote יום המשפחה and מסיבת סיום and this table showed neither, so they
     * read as "not imported" when they were sitting one collection away.
     */
    const specialFilter = { academic_year: filter.academic_year };
    if (filter.branch_id) specialFilter.$or = [{ branch_id: null }, { branch_id: filter.branch_id }];
    const specialDays = filter.academic_year
      ? await SpecialDay.find(specialFilter).populate('branch_id', 'name').sort({ date: 1 }).lean()
      : [];

    res.json({
      holidays: holidays.map(h => ({ ...h, id: h._id })),
      special_days: specialDays.map(d => ({ ...d, id: d._id })),
    });
  } catch (error) { next(error); }
}

async function create(req, res, next) {
  try {
    const { branch_id, academic_year, name, start_date, end_date, is_custom, is_half_day, end_time } = req.body;
    if (!branch_id || !name || !start_date || !end_date) {
      return res.status(400).json({ error: 'שדות חובה חסרים' });
    }

    const baseDoc = {
      academic_year: academic_year || '',
      name, start_date, end_date,
      is_custom: is_custom || false,
      is_half_day: !!is_half_day,
      end_time: is_half_day ? (end_time || '12:00') : '',
    };

    // Sentinel "all" → create the holiday for every active branch the user
    // has access to. Frontend may also send empty string with the same intent.
    if (branch_id === 'all' || branch_id === '*' || !branch_id) {
      const filter = { is_active: true };
      const role = req.user?.role;
      if (role && role !== 'system_admin' && role !== 'accountant') {
        const managed = (req.user.managed_branch_ids || []).map(String);
        const fallback = req.user.branch_id ? [String(req.user.branch_id)] : [];
        const allowed = managed.length > 0 ? managed : fallback;
        filter._id = { $in: allowed };
      }
      const branches = await Branch.find(filter).select('_id').lean();
      if (branches.length === 0) {
        return res.status(400).json({ error: 'לא נמצאו סניפים פעילים' });
      }
      const created = await Holiday.insertMany(
        branches.map(b => ({ ...baseDoc, branch_id: b._id })),
      );
      return res.status(201).json({
        holidays: created.map(h => ({ ...h.toObject(), id: h._id })),
        count: created.length,
      });
    }

    const holiday = await Holiday.create({ ...baseDoc, branch_id });
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


/**
 * POST /api/holidays/import-year   { academic_year }
 *
 * Write the published year into every branch. Idempotent by (branch, year,
 * name, start date): running it twice updates rather than duplicates, which
 * matters because the obvious way to fix a typo in the published list is to
 * correct the source and run it again.
 *
 * A row the office has since edited by hand is left alone — `is_custom` is the
 * flag for "a person decided this", and an import must not undo a decision.
 */
async function importYear(req, res, next) {
  try {
    const requested = req.body?.academic_year || vacationCalendar.YEAR_5787;
    const calendar = vacationCalendar.calendarFor(requested);
    if (!calendar) {
      return res.status(400).json({ error: `אין לוח חופשות מוגדר לשנת ${requested}` });
    }
    // Stored under the key the rest of the system uses, whatever the caller
    // called it — otherwise the rows are written where nothing looks for them.
    const academicYear = vacationCalendar.normalizeYearKey(requested);

    const branches = await Branch.find({}).select('_id name').lean();
    if (!branches.length) return res.status(400).json({ error: 'לא נמצאו סניפים' });

    const report = [];
    for (const branch of branches) {
      let created = 0; let updated = 0; let skipped = 0;
      for (const entry of calendar.entries) {
        const { model, doc } = vacationCalendar.toDocument(entry, branch._id, academicYear);

        if (model === 'SpecialDay') {
          const existing = await SpecialDay.findOne({
            branch_id: branch._id, date: doc.date, academic_year: academicYear,
          });
          if (existing) { await SpecialDay.updateOne({ _id: existing._id }, doc); updated += 1; }
          else { await SpecialDay.create(doc); created += 1; }
          continue;
        }

        // Matched on the DATE, not the name. A row the office renamed —
        // which is the most likely hand-edit there is — would otherwise not be
        // recognised, and the import would helpfully add the original back
        // beside it. Two closures never share a start date in a published year.
        const existing = await Holiday.findOne({
          branch_id: branch._id, academic_year: academicYear,
          start_date: doc.start_date,
        });
        if (existing?.is_custom) { skipped += 1; continue; }
        if (existing) { await Holiday.updateOne({ _id: existing._id }, doc); updated += 1; }
        else { await Holiday.create(doc); created += 1; }
      }
      report.push({ branch: branch.name, created, updated, skipped });
    }

    res.json({ ok: true, academic_year: academicYear, branches: report });
  } catch (error) { next(error); }
}

/** GET /api/holidays/calendar?branch=<id>&year=<תשפ״ז> — the merged year. */
async function calendar(req, res, next) {
  try {
    const branchId = req.query.branch;
    if (!branchId) return res.status(400).json({ error: 'יש לציין סניף' });
    const year = vacationCalendar.normalizeYearKey(req.query.year || vacationCalendar.YEAR_5787);
    res.json(await vacationCalendar.readCalendar(branchId, year));
  } catch (error) { next(error); }
}

module.exports = { getAll, create, update, remove, copyFromBranch, importYear, calendar };
