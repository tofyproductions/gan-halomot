const { getAcademicYears, getHebrewYear, getAcademicYearStr } = require('../services/academic-year.service');

/**
 * GET /api/utils/academic-years
 * Return current and next academic years
 */
async function getAcademicYearsHandler(req, res, next) {
  try {
    const years = getAcademicYears();
    res.json(years);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/utils/hebrew-year?date=2025-09-15
 * Return hebrew year info for a given date
 */
async function getHebrewYearInfo(req, res, next) {
  try {
    const { date } = req.query;
    const targetDate = date || new Date().toISOString().split('T')[0];

    const hebrewYear = getHebrewYear(targetDate);
    const academicYear = getAcademicYearStr(targetDate);

    res.json({
      date: targetDate,
      hebrewYear,
      academicYear,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getAcademicYears: getAcademicYearsHandler,
  getHebrewYearInfo,
};
