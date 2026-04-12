const db = require('../config/database');
const { getAcademicYears, normalizeYear, ACADEMIC_MONTHS } = require('../services/academic-year.service');

/**
 * GET /api/dashboard?year=2025
 * Return dashboard stats: classrooms with kids, pending leads, forecast
 */
async function getStats(req, res, next) {
  try {
    const { year } = req.query;
    const academicYears = getAcademicYears();
    const targetYear = year
      ? normalizeYear(year)
      : academicYears.current.range;

    // --- Classrooms with children ---
    const children = await db('children')
      .select(
        'children.*',
        'classrooms.name as classroom_name',
        'classrooms.capacity as classroom_capacity'
      )
      .leftJoin('classrooms', 'children.classroom_id', 'classrooms.id')
      .where('children.academic_year', targetYear)
      .andWhere('children.is_active', true)
      .orderBy('classrooms.name')
      .orderBy('children.child_name');

    const classrooms = {};
    for (const child of children) {
      const groupName = child.classroom_name || 'ללא קבוצה';
      if (!classrooms[groupName]) {
        classrooms[groupName] = [];
      }
      classrooms[groupName].push({
        id: child.id,
        child_name: child.child_name,
        birth_date: child.birth_date,
        parent_name: child.parent_name,
        phone: child.phone,
        registration_id: child.registration_id,
      });
    }

    // --- Pending leads (registrations not yet completed) ---
    const pendingLeads = await db('registrations')
      .select(
        'registrations.*',
        'classrooms.name as classroom_name'
      )
      .leftJoin('classrooms', 'registrations.classroom_id', 'classrooms.id')
      .whereIn('registrations.status', ['link_generated', 'contract_signed', 'docs_uploaded'])
      .orderBy('registrations.created_at', 'desc');

    // --- Forecast from registrations ---
    const allRegistrations = await db('registrations')
      .select(
        'registrations.*',
        'classrooms.name as classroom_name'
      )
      .leftJoin('classrooms', 'registrations.classroom_id', 'classrooms.id')
      .orderBy('registrations.created_at', 'desc');

    const forecast = buildForecast(allRegistrations, targetYear);

    res.json({
      classrooms,
      pendingLeads,
      forecast,
      academicYear: targetYear,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Build forecast data from registrations (ported from GAS calculateForecast)
 */
function buildForecast(registrations, academicYear) {
  const [y1, y2] = academicYear.split('-').map(Number);
  if (!y1 || !y2) return [];

  const monthlyData = ACADEMIC_MONTHS.map(m => {
    const calendarYear = m >= 9 ? y1 : y2;
    return {
      month: m,
      year: calendarYear,
      label: new Date(calendarYear, m - 1, 1).toLocaleDateString('he-IL', { month: 'long', year: 'numeric' }),
      expectedChildren: 0,
      expectedRevenue: 0,
    };
  });

  for (const reg of registrations) {
    if (!reg.start_date || !reg.monthly_fee) continue;

    const startDate = new Date(reg.start_date);
    const endDate = reg.end_date ? new Date(reg.end_date) : new Date(y2, 7, 31);
    const fee = parseFloat(reg.monthly_fee) || 0;

    for (const entry of monthlyData) {
      const monthStart = new Date(entry.year, entry.month - 1, 1);
      const monthEnd = new Date(entry.year, entry.month, 0);

      if (startDate <= monthEnd && endDate >= monthStart) {
        entry.expectedChildren++;
        entry.expectedRevenue += fee;
      }
    }
  }

  return monthlyData;
}

/**
 * GET /api/dashboard/classrooms?year=2026
 * Return classrooms grouped data (alias for dashboard view)
 */
async function getClassrooms(req, res, next) {
  try {
    const { year } = req.query;
    const academicYears = getAcademicYears();
    const targetYear = year
      ? normalizeYear(year)
      : academicYears.current.range;

    const children = await db('children')
      .select(
        'children.*',
        'classrooms.name as classroom_name',
        'classrooms.capacity as classroom_capacity',
        'classrooms.id as classroom_id_ref'
      )
      .leftJoin('classrooms', 'children.classroom_id', 'classrooms.id')
      .where('children.academic_year', targetYear)
      .andWhere('children.is_active', true)
      .orderBy('classrooms.name')
      .orderBy('children.child_name');

    const classrooms = {};
    for (const child of children) {
      const groupName = child.classroom_name || 'ללא קבוצה';
      if (!classrooms[groupName]) {
        classrooms[groupName] = {
          classroom_id: child.classroom_id_ref,
          capacity: child.classroom_capacity,
          children: [],
        };
      }
      classrooms[groupName].children.push({
        id: child.id,
        child_name: child.child_name,
        birth_date: child.birth_date,
        parent_name: child.parent_name,
        phone: child.phone,
        registration_id: child.registration_id,
      });
    }

    res.json({ classrooms, academicYear: targetYear });
  } catch (error) {
    next(error);
  }
}

module.exports = { getStats, getClassrooms };
