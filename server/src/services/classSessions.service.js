const { ClassProgram, ClassSession } = require('../models');
const vacationCalendar = require('./vacationCalendar');

/**
 * The academic year a month belongs to, in the key the calendar is stored by.
 * September opens the year: 2026-09 → '2026-2027', 2027-06 → '2026-2027'.
 */
function academicYearOf(month) {
  const [y, m] = month.split('-').map(Number);
  return m >= 9 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}

/**
 * The days a branch is SHUT in a month, by date, with the holiday's name.
 *
 * An instructor does not come to a closed gan. Before this, the fixed day was
 * taken literally and a Monday inside סוכות got a session like any other — a
 * meeting on the board that nobody agreed to, a popup asking whether she came
 * on a day the building was locked, and, if somebody ticked it out of habit, a
 * paid lesson that never happened.
 *
 * Read from the branch's stored calendar (holidays and employer closures
 * together, the way every other screen reads it). A branch whose year was
 * never imported falls back to the published calendar: the gan is closed on
 * יום כיפור whether or not somebody pressed the import button. A short day
 * is open — she comes, the gan just finishes early.
 */
async function closedDaysOf(branchId, month) {
  const year = academicYearOf(month);
  let calendar = await vacationCalendar.readCalendar(branchId, year);
  if (!(calendar.entries || []).length) {
    const published = vacationCalendar.calendarFor(year);
    calendar = { entries: published ? published.entries : [] };
  }
  const closed = new Map();
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    const st = vacationCalendar.statusOn(calendar, date);
    if (!st.open) closed.set(date, st.name || 'הגן סגור');
  }
  return closed;
}

/**
 * Put the month's meetings on the board.
 *
 * NOTHING ASKS A QUESTION ABOUT A MEETING THAT DOES NOT EXIST. The occurrence
 * popup reads sessions whose time has passed; a class with a fixed Tuesday and
 * no Tuesdays written down is a class nobody is ever asked about, which looks
 * from the manager's chair exactly like a month with no classes in it. Until
 * this existed, every meeting was typed in by hand, one date at a time.
 *
 * So the fixed day on the program is taken literally: every date in the month
 * that falls on it gets a session. A date that already has one is LEFT ALONE,
 * whatever its status — re-running this must never duplicate a meeting, and a
 * meeting already answered must never be reset by a later fill.
 *
 * A program with no fixed day (`default_day === null`) is deliberately skipped.
 * Those are the ad-hoc ones, and guessing dates for them would put meetings on
 * the board that nobody agreed to and then ask a manager to deny them.
 *
 * DATES ALREADY PAST ARE SKIPPED unless asked for. The first run of this on the
 * live gan wrote three meetings into the week that had already gone, and the
 * popup would have opened asking a manager whether an instructor came last
 * Monday — a question she cannot answer from memory, about a week nobody was
 * tracking. Two or three of those and the popup is a thing you close, which
 * costs more than the meetings are worth. `includePast` is there for somebody
 * deliberately reconstructing a month, and the nightly job never sets it.
 */
async function fillMonth({ month, programId = null, branchIds = null, includePast = false }) {
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) {
    throw Object.assign(new Error('חודש לא תקין'), { status: 400 });
  }
  const [y, m] = month.split('-').map(Number);

  const filter = { is_active: true, default_day: { $ne: null } };
  if (programId) filter._id = programId;
  if (Array.isArray(branchIds)) filter.branch_id = { $in: branchIds };
  const programs = await ClassProgram.find(filter).lean();
  if (programs.length === 0) return { created: 0, skipped: 0, programs: 0, closed: [] };

  // Every date in the month, as YYYY-MM-DD with its weekday. Built from UTC so
  // the day-of-month never shifts under a timezone — these are calendar dates,
  // not moments.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  const days = [];
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    if (!includePast && date < today) continue;
    const dt = new Date(Date.UTC(y, m - 1, d));
    days.push({ date, weekday: dt.getUTCDay() });
  }

  const existing = await ClassSession.find({
    program_id: { $in: programs.map(p => p._id) },
    date: { $regex: `^${month}` },
  }).select('program_id date').lean();
  const taken = new Set(existing.map(s => `${s.program_id}|${s.date}`));

  // One calendar read per branch, not per program.
  const closedByBranch = new Map();
  for (const p of programs) {
    const bk = String(p.branch_id);
    if (!closedByBranch.has(bk)) closedByBranch.set(bk, await closedDaysOf(p.branch_id, month));
  }

  const docs = [];
  let skipped = 0;
  const closed = new Map(); // date → holiday name, for every date a session was NOT written
  for (const p of programs) {
    const closedDays = closedByBranch.get(String(p.branch_id));
    for (const { date, weekday } of days) {
      if (weekday !== p.default_day) continue;
      if (taken.has(`${p._id}|${date}`)) { skipped++; continue; }
      if (closedDays.has(date)) { closed.set(date, closedDays.get(date)); continue; }
      docs.push({
        program_id: p._id,
        branch_id: p.branch_id,
        classroom_id: p.classroom_id || null,
        date,
        time: p.default_time || '',
        rate: Number(p.default_rate) || 0,
        status: 'scheduled',
      });
    }
  }
  if (docs.length) await ClassSession.insertMany(docs);
  return {
    created: docs.length,
    skipped,
    programs: programs.length,
    closed: [...closed.entries()].sort().map(([date, name]) => ({ date, name })),
  };
}

/** 'YYYY-MM' for a date, in Israel. */
function monthOf(d = new Date()) {
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }).slice(0, 7);
}

/** The month after the given one. */
function nextMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/**
 * The daily top-up: this month and the next one.
 *
 * Next month as well as this one, because a class added on the 28th would
 * otherwise have nothing on the board until the 1st, and because a manager
 * looking ahead at the gantt should see what is coming. Idempotent, so running
 * it every day costs one query and writes nothing on most of them.
 */
async function fillUpcoming() {
  const now = monthOf();
  const a = await fillMonth({ month: now });
  const b = await fillMonth({ month: nextMonth(now) });
  return { created: a.created + b.created, months: [now, nextMonth(now)] };
}

module.exports = { fillMonth, fillUpcoming, monthOf, nextMonth, academicYearOf, closedDaysOf };
