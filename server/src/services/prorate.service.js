/**
 * Pro-rate Calculation Service
 * Ported from GAS: calculateFirstMonthPayment(), calculateAugustPayment(), calculatePaymentStatus()
 */

const { ACADEMIC_MONTHS } = require('./academic-year.service');

/**
 * Calculate first month pro-rated fee
 */
function calculateFirstMonthPayment(monthlyFee, startDate) {
  if (!monthlyFee || !startDate) return { fee: 0, note: '' };

  const feeNum = parseFloat(String(monthlyFee).replace(/[^\d.]/g, '')) || 0;
  if (feeNum <= 0) return { fee: 0, note: '' };

  const d = new Date(startDate);
  if (isNaN(d.getTime())) return { fee: feeNum, note: '' };

  const day = d.getDate();
  if (day <= 1) return { fee: feeNum, note: '' };

  const month = d.getMonth();
  const year = d.getFullYear();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysUtilized = daysInMonth - day + 1;
  const dailyRate = feeNum / daysInMonth;
  const proRatedFee = Math.round(dailyRate * daysUtilized);

  const HEBREW_MONTHS = [
    'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
    'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר',
  ];
  const monthName = HEBREW_MONTHS[month];
  const note = `חישוב יחסי עבור ${daysUtilized} ימים בחודש ${monthName} מתוך ${daysInMonth} ימים`;

  return { fee: proRatedFee, note };
}

/**
 * Calculate August payment (relative to active months)
 */
function calculateAugustPayment(fee, startDateStr) {
  if (!fee || !startDateStr) return { total: fee, months: 12, isProrated: false };

  const feeNum = parseFloat(fee);
  const start = new Date(startDateStr);
  const month = start.getMonth() + 1;

  let months = 0;
  if (month >= 9) {
    months = (12 - month) + 1 + 8;
  } else {
    months = (8 - month) + 1;
  }

  if (months >= 12 || months <= 0) return { total: feeNum, months: 12, isProrated: false };

  const base = feeNum / 3;
  const remainder = feeNum * (2 / 3);
  const monthlyOverhead = remainder / 12;
  const total = base + (monthlyOverhead * months);

  return { total: Math.round(total * 100) / 100, months, isProrated: true };
}

/**
 * Calculate expected fees per month for a child within an academic year
 */
function calculatePaymentStatus(fullFee, startDate, acadYearStr, endDate, priceChangeMonth, newFee) {
  if (!fullFee || !startDate || !acadYearStr) return { expectedFees: {}, isBeforeStart: {} };

  const [y1, y2] = acadYearStr.split('-').map(Number);
  const acadRangeStart = new Date(y1, 8, 1); // Sept 1
  const acadRangeEnd = new Date(y2, 7, 31);  // Aug 31

  const effectiveStartDate = startDate ? new Date(startDate) : acadRangeStart;
  let childEndDate = endDate ? new Date(endDate) : acadRangeEnd;

  const expectedFees = {};
  const isBeforeStart = {};

  ACADEMIC_MONTHS.forEach(m => {
    const currentY = m >= 9 ? y1 : y2;
    const monthDate = new Date(currentY, m - 1, 1);
    const monthEnd = new Date(currentY, m, 0);

    if (effectiveStartDate > monthEnd) {
      isBeforeStart[m] = true;
      expectedFees[m] = 0;
      return;
    }

    isBeforeStart[m] = false;

    if (monthDate > childEndDate) {
      expectedFees[m] = 0;
      return;
    }

    const isStartMonth = effectiveStartDate.getMonth() === m - 1 && effectiveStartDate.getFullYear() === currentY;
    const isEndMonth = childEndDate.getMonth() === m - 1 && childEndDate.getFullYear() === currentY;

    // Determine current fee (accounting for mid-year price changes)
    let currentMonthlyFee = fullFee;
    if (priceChangeMonth && newFee) {
      const pcMonth = parseInt(priceChangeMonth);
      const sequence = ACADEMIC_MONTHS;
      const currentIndex = sequence.indexOf(m);
      const pcIndex = sequence.indexOf(pcMonth);
      if (currentIndex !== -1 && pcIndex !== -1 && currentIndex >= pcIndex) {
        currentMonthlyFee = newFee;
      }
    }

    if (isStartMonth || isEndMonth) {
      const pStart = isStartMonth ? effectiveStartDate.getDate() : 1;
      const pEnd = isEndMonth ? childEndDate.getDate() : monthEnd.getDate();
      const totalDays = monthEnd.getDate();
      const daysAttended = Math.max(0, pEnd - pStart + 1);
      expectedFees[m] = Math.round((daysAttended / totalDays) * currentMonthlyFee);
    } else {
      expectedFees[m] = currentMonthlyFee;
    }
  });

  // August special calculation
  if (expectedFees[8] > 0 && !isBeforeStart[8]) {
    let activeExclAug = 0;
    ACADEMIC_MONTHS.forEach(m => {
      if (m !== 8 && expectedFees[m] > 0) activeExclAug++;
    });
    const base = fullFee / 3;
    const remainder = fullFee * (2 / 3);
    const monthlyOverhead = remainder / 12;
    const total = base + (monthlyOverhead * (activeExclAug + 1));
    expectedFees[8] = Math.round(total);
  }

  return { expectedFees, isBeforeStart };
}

module.exports = {
  calculateFirstMonthPayment,
  calculateAugustPayment,
  calculatePaymentStatus,
};
