const { Child, Registration, Classroom } = require('../models');
const { getAcademicYears, normalizeYear, ACADEMIC_MONTHS } = require('../services/academic-year.service');
const { getBranchFilter } = require('../utils/branch-filter');

async function getStats(req, res, next) {
  try {
    const { year } = req.query;
    const academicYears = getAcademicYears();
    const targetYear = year ? normalizeYear(year) : academicYears.current.range;
    const branchFilter = getBranchFilter(req);

    // Get classrooms for this branch
    const branchClassrooms = await Classroom.find({ is_active: true, ...branchFilter }).select('_id').lean();
    const branchClassroomIds = branchClassrooms.map(c => c._id);

    // Classrooms with children (filter by branch classrooms)
    const childFilter = { academic_year: targetYear, is_active: true };
    if (branchClassroomIds.length > 0 && Object.keys(branchFilter).length > 0) {
      childFilter.classroom_id = { $in: branchClassroomIds };
    }

    const children = await Child.find(childFilter)
      .populate('classroom_id', 'name capacity')
      .sort({ child_name: 1 })
      .lean();

    const classrooms = {};
    for (const child of children) {
      const groupName = child.classroom_id?.name || 'ללא קבוצה';
      if (!classrooms[groupName]) classrooms[groupName] = [];
      classrooms[groupName].push({
        id: child._id,
        child_name: child.child_name,
        birth_date: child.birth_date,
        parent_name: child.parent_name,
        phone: child.phone,
        registration_id: child.registration_id,
      });
    }

    // Pending leads
    const leadFilter = {
      status: { $in: ['link_generated', 'contract_signed', 'docs_uploaded'] },
      ...branchFilter,
    };
    const pendingLeads = await Registration.find(leadFilter)
      .populate('classroom_id', 'name')
      .sort({ created_at: -1 })
      .lean();

    const formattedLeads = pendingLeads.map(l => ({
      ...l,
      id: l._id,
      classroom_name: l.classroom_id?.name || null,
      classroom_id: l.classroom_id?._id || l.classroom_id,
    }));

    // Forecast
    const regFilter = Object.keys(branchFilter).length > 0 ? branchFilter : {};
    const allRegistrations = await Registration.find(regFilter)
      .populate('classroom_id', 'name')
      .sort({ created_at: -1 })
      .lean();

    const forecast = buildForecast(allRegistrations, targetYear);

    // Next year forecast
    const academicYearsInfo = getAcademicYears();
    const nextYear = academicYearsInfo.next.range;
    const nextYearRegs = await Registration.find(regFilter)
      .populate('classroom_id', 'name')
      .lean();
    const forecastNextYear = buildForecast(nextYearRegs, nextYear);

    // Classroom capacity info for occupancy chart
    const classroomCapacity = await Classroom.find({
      is_active: true,
      academic_year: targetYear,
      ...branchFilter,
    }).select('name capacity').lean();

    // Total branch capacity (sum of all classroom capacities)
    const totalCapacity = classroomCapacity.reduce((sum, c) => sum + (c.capacity || 0), 0);

    res.json({
      classrooms,
      pendingLeads: formattedLeads,
      forecast,
      forecastNextYear,
      classroomCapacity: classroomCapacity.map(c => ({ name: c.name, capacity: c.capacity || 0 })),
      totalCapacity,
      academicYear: targetYear,
      nextAcademicYear: nextYear,
    });
  } catch (error) {
    next(error);
  }
}

function buildForecast(registrations, academicYear) {
  const [y1, y2] = academicYear.split('-').map(Number);
  if (!y1 || !y2) return [];

  // Collect all classroom names
  const classroomSet = new Set();
  registrations.forEach(r => {
    const cls = r.classroom_id?.name || 'ללא קבוצה';
    classroomSet.add(cls);
  });

  const monthlyData = ACADEMIC_MONTHS.map(m => {
    const calendarYear = m >= 9 ? y1 : y2;
    const entry = {
      month: m,
      year: calendarYear,
      label: new Date(calendarYear, m - 1, 1).toLocaleDateString('he-IL', { month: 'long', year: 'numeric' }),
      expectedChildren: 0,
      expectedRevenue: 0,
      byClassroom: {},
    };
    for (const cls of classroomSet) {
      entry.byClassroom[cls] = 0;
    }
    return entry;
  });

  for (const reg of registrations) {
    if (!reg.start_date || !reg.monthly_fee) continue;
    const startDate = new Date(reg.start_date);
    const endDate = reg.end_date ? new Date(reg.end_date) : new Date(y2, 7, 31);
    const fee = parseFloat(reg.monthly_fee) || 0;
    const cls = reg.classroom_id?.name || 'ללא קבוצה';

    for (const entry of monthlyData) {
      const monthStart = new Date(entry.year, entry.month - 1, 1);
      const monthEnd = new Date(entry.year, entry.month, 0);
      if (startDate <= monthEnd && endDate >= monthStart) {
        entry.expectedChildren++;
        entry.expectedRevenue += fee;
        entry.byClassroom[cls] = (entry.byClassroom[cls] || 0) + 1;
      }
    }
  }

  return monthlyData;
}

async function getClassrooms(req, res, next) {
  try {
    const { year } = req.query;
    const academicYears = getAcademicYears();
    const targetYear = year ? normalizeYear(year) : academicYears.current.range;
    const branchFilter = getBranchFilter(req);

    const branchClassrooms = await Classroom.find({ is_active: true, ...branchFilter }).select('_id').lean();
    const branchClassroomIds = branchClassrooms.map(c => c._id);

    const childFilter = { academic_year: targetYear, is_active: true };
    if (branchClassroomIds.length > 0 && Object.keys(branchFilter).length > 0) {
      childFilter.classroom_id = { $in: branchClassroomIds };
    }

    const children = await Child.find(childFilter)
      .populate('classroom_id', 'name capacity')
      .sort({ child_name: 1 })
      .lean();

    const classrooms = {};
    for (const child of children) {
      const groupName = child.classroom_id?.name || 'ללא קבוצה';
      if (!classrooms[groupName]) {
        classrooms[groupName] = {
          classroom_id: child.classroom_id?._id,
          capacity: child.classroom_id?.capacity,
          children: [],
        };
      }
      classrooms[groupName].children.push({
        id: child._id,
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
