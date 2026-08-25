/**
 * Which week a date belongs to, and whether parents may see it.
 *
 * The week key is the only tricky part and it is worth getting right once:
 * ISO weeks start on Monday, an Israeli gan week starts on Sunday, and a
 * function that quietly uses one while its callers assume the other puts
 * Sunday's plan in last week's box — which nobody notices until a parent says
 * the gan published nothing and the gan says it did.
 *
 * So the week here starts on SUNDAY, explicitly, and is labelled by the
 * calendar year and the index of that Sunday within the year. The label is
 * never parsed back into a date; it is a key, and only ever compared to
 * another key produced by this same function.
 */

const IL_TZ = 'Asia/Jerusalem';

/** 'YYYY-MM-DD' in Israel local time. */
function ymdOf(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: IL_TZ }).format(new Date(date));
}

/** The Sunday on or before `ymd`, as 'YYYY-MM-DD'. */
function weekStart(ymd) {
  const d = new Date(`${ymd}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}

/**
 * The stored key for the week containing `ymd` — 'YYYY-Www', counting Sundays
 * from the first of the year. Derived from the Sunday, so every day of a week
 * that straddles New Year gets the same key.
 */
function weekKey(ymd) {
  const sunday = weekStart(ymd);
  const year = Number(sunday.slice(0, 4));
  const jan1 = new Date(Date.UTC(year, 0, 1, 12));
  const start = new Date(`${sunday}T12:00:00.000Z`);
  const index = Math.floor((start - jan1) / 604800000) + 1;
  return `${year}-W${String(index).padStart(2, '0')}`;
}

const weekKeyOf = (date = new Date()) => weekKey(ymdOf(date));

/** The seven 'YYYY-MM-DD' of the week containing `ymd`. */
function weekDates(ymd) {
  const start = new Date(`${weekStart(ymd)}T12:00:00.000Z`);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
}

/**
 * What a parent may see for one branch in one week.
 *
 * Defaults live here rather than in the schema so that "no row" and "a row
 * that was never edited" answer identically — a caller must never have to know
 * whether somebody has visited the screen.
 */
function applyDefaults(row, weekKeyValue) {
  return {
    week: weekKeyValue,
    // Never shown before, so publishing is a decision somebody makes.
    gantt: row ? !!row.gantt : false,
    // Already shown today. Defaulting this off would take something away.
    menu: row ? !!row.menu : true,
    set_by_name: row?.set_by_name || '',
    is_default: !row,
  };
}

async function visibilityFor(branchId, weekKeyValue) {
  const { ParentVisibility } = require('../models');
  const row = await ParentVisibility.findOne({ branch_id: branchId, week: weekKeyValue }).lean();
  return applyDefaults(row, weekKeyValue);
}

/**
 * A requested date, or today. Rejected rather than trusted: the value arrives
 * in a URL, and 'YYYY-MM-DD' is the only shape every function here can read.
 */
function normalizeRequestedDate(raw) {
  const s = String(raw || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00.000Z`))) return s;
  return ymdOf(new Date());
}

module.exports = {
  ymdOf, weekStart, weekKey, weekKeyOf, weekDates,
  visibilityFor, applyDefaults, normalizeRequestedDate,
};
