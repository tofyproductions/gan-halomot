const { Absence } = require('../models');
const { loadOwnChild } = require('./parentPortal.controller');

/**
 * The parent's side of "she will not be in tomorrow".
 *
 * TODAY OR LATER, never yesterday. A report is a heads-up, and a family
 * "reporting" a day that has already happened is editing the gan's record of a
 * day it witnessed — DailyLog.attendance is the staff's own observation and
 * nothing here may touch it. The limit is also what keeps the morning list
 * honest: everything on it is something somebody said in advance.
 *
 * FOURTEEN DAYS AHEAD at the most. Not a technical bound — a family that knows
 * about a fortnight away is telling the office about a holiday, and that is a
 * conversation rather than a checkbox on a screen the teacher reads at 7am.
 */

const MAX_DAYS_AHEAD = 14;

/** 'YYYY-MM-DD' for a date, in local time. */
function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The days a parent may still report, as plain strings the client compares. */
function reportableWindow() {
  const out = [];
  const start = new Date();
  for (let i = 0; i <= MAX_DAYS_AHEAD; i += 1) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    out.push(dayKey(d));
  }
  return out;
}

function isReportable(date) {
  return reportableWindow().includes(String(date));
}

/** GET /api/parent/children/:childId/absences — what this family has reported. */
async function list(req, res) {
  const own = await loadOwnChild(req);
  if (!own) return res.status(404).json({ error: 'לא נמצא' });

  const today = dayKey();
  const rows = await Absence.find({
    child_id: own.child._id,
    cancelled_at: null,
    // Only from today on. Last month's absences are the gan's record, not a
    // list a parent has anything to do about.
    date: { $gte: today },
  }).sort({ date: 1 }).lean();

  res.json({
    today,
    max_date: reportableWindow().slice(-1)[0],
    absences: rows.map(a => ({ id: a._id, date: a.date, reason: a.reason })),
  });
}

/**
 * POST /api/parent/children/:childId/absences  { dates: ['YYYY-MM-DD'], reason }
 *
 * Several days at once, because illness is Sunday to Tuesday and reporting it
 * three times is three chances to forget one. Stored a day at a time all the
 * same — see models/Absence.
 *
 * A day already reported is not an error. The parent's intent is "she is not
 * coming on these days", and answering "you already said that" for one of four
 * would leave them unsure whether the other three were taken.
 */
async function create(req, res) {
  const own = await loadOwnChild(req);
  if (!own) return res.status(404).json({ error: 'לא נמצא' });

  const dates = [...new Set(req.body?.dates || [])].filter(isReportable);
  if (!dates.length) {
    return res.status(400).json({ error: 'יש לבחור תאריך מהיום ואילך' });
  }

  const { child, account } = own;
  const reason = String(req.body?.reason || '').trim().slice(0, 300);

  for (const date of dates) {
    // Upsert, so a second tap and a second parent are one absence. Reviving a
    // cancelled one is deliberate: reporting a day they had withdrawn is
    // exactly the same statement as reporting it the first time.
    await Absence.findOneAndUpdate(
      { child_id: child._id, date },
      {
        $set: {
          classroom_id: child.classroom_id?._id || child.classroom_id || null,
          branch_id: child.classroom_id?.branch_id || null,
          child_name: child.child_name,
          reason,
          reported_by: account._id,
          reported_by_name: account.full_name || '',
          cancelled_at: null,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  }

  return list(req, res);
}

/**
 * DELETE /api/parent/children/:childId/absences/:date
 *
 * Withdraws rather than deletes, and only for a day that has not arrived: once
 * the morning is under way the teacher has read the list and planned around
 * it, and a row vanishing behind her is worse than a row she has to re-read.
 */
async function cancel(req, res) {
  const own = await loadOwnChild(req);
  if (!own) return res.status(404).json({ error: 'לא נמצא' });

  const date = String(req.params.date || '');
  if (date <= dayKey()) {
    return res.status(409).json({ error: 'אי אפשר לבטל דיווח על היום או על יום שעבר. יש לפנות לגן.' });
  }

  await Absence.updateOne(
    { child_id: own.child._id, date, cancelled_at: null },
    { $set: { cancelled_at: new Date() } },
  );

  return list(req, res);
}

module.exports = { list, create, cancel, dayKey, MAX_DAYS_AHEAD };
