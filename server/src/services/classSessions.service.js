const { ClassProgram, ClassSession } = require('../models');

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
  if (programs.length === 0) return { created: 0, skipped: 0, programs: 0 };

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

  const docs = [];
  let skipped = 0;
  for (const p of programs) {
    for (const { date, weekday } of days) {
      if (weekday !== p.default_day) continue;
      if (taken.has(`${p._id}|${date}`)) { skipped++; continue; }
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
  return { created: docs.length, skipped, programs: programs.length };
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

module.exports = { fillMonth, fillUpcoming, monthOf, nextMonth };
