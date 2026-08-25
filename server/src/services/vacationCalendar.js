/**
 * לוח החופשות של שנת הלימודים.
 *
 * THREE KINDS, AND THE DIFFERENCE IS MONEY. The list a parent reads is one
 * list; what it costs an employee is not. Collapsing them is how a member of
 * staff ends up paying a vacation day for a day she came in and worked.
 *
 *   closure     → Holiday. The gan does not run and the day is drawn from her
 *                 balance. Every calendar holiday is this.
 *   employer    → SpecialDay. The gan does not run because WE decided to shut —
 *                 the staff day, the end-of-year party. Nothing is drawn from
 *                 her balance and a global employee is not docked.
 *   short_day   → Holiday with kind='short_day'. The gan RUNS and finishes
 *                 early. She is paid for the hours she punched and nothing is
 *                 drawn. Both other kinds would be wrong here.
 *
 * The dates below were checked one by one against the actual weekdays of
 * 2026-27 before being written down; the day names are what the gan published
 * and they agree.
 */

/**
 * The year's key, in the form the REST OF THE SYSTEM uses.
 *
 * `Classroom.academic_year`, `Child.academic_year` and `Holiday.academic_year`
 * all hold the Gregorian range — '2026-2027'. Keying this file by the Hebrew
 * name instead made the import refuse every branch with "אין לוח חופשות
 * מוגדר", because nothing else in the application ever asks for 'תשפ״ז'.
 *
 * The Hebrew name is kept as an alias: it is what a person says out loud, and
 * a caller that passes it should be understood rather than corrected.
 */
const YEAR_5787 = '2026-2027';
const YEAR_5787_HEBREW = 'תשפ״ז';

const CALENDAR_5787 = [
  {
    key: 'rosh-hashana', kind: 'closure', name: 'ראש השנה',
    start: '2026-09-11', end: '2026-09-13',
    hebrew: 'כ״ט אלול – ב׳ תשרי', return_note: 'חזרה לגן: יום שני, 14.9',
    emoji: '🍎', color: '#e8443b',
  },
  {
    key: 'yom-kippur', kind: 'closure', name: 'יום כיפור',
    start: '2026-09-20', end: '2026-09-21',
    hebrew: 'ט׳ – י׳ תשרי', return_note: 'חזרה לגן: יום שלישי, 22.9',
    emoji: '🕯️', color: '#f5871f',
  },
  {
    key: 'sukkot', kind: 'closure', name: 'סוכות',
    start: '2026-09-25', end: '2026-10-03',
    hebrew: 'י״ד – כ״ב תשרי', return_note: 'חזרה לגן: יום ראשון, 4.10',
    emoji: '🌿', color: '#f0a500',
  },
  {
    key: 'hanukkah', kind: 'closure', name: 'חנוכה',
    start: '2026-12-10', end: '2026-12-11',
    hebrew: 'ל׳ כסלו – א׳ טבת', return_note: 'חזרה לגן: יום ראשון, 13.12',
    emoji: '🕎', color: '#2bb673',
  },
  {
    // The gan is SHUT for the whole day, and the employer absorbs it — this is
    // not a calendar holiday and must not come out of anybody's balance.
    key: 'family-day', kind: 'employer', name: 'יום המשפחה · קטיף תותים',
    start: '2027-02-19', end: '2027-02-19',
    note: 'אירוע מיוחד — הגן סגור', emoji: '🍓', color: '#17a2b8',
  },
  {
    key: 'purim', kind: 'closure', name: 'פורים',
    start: '2027-03-23', end: '2027-03-23',
    hebrew: 'י״ד אדר ב׳', return_note: 'חזרה לגן: יום רביעי, 24.3',
    emoji: '🎭', color: '#2e7dd7',
  },
  {
    key: 'pesach', kind: 'closure', name: 'פסח',
    start: '2027-04-19', end: '2027-04-28',
    hebrew: 'י״ב – כ״א ניסן', return_note: 'חזרה לגן: יום חמישי, 29.4',
    emoji: '🍷', color: '#5b57c9',
  },
  {
    // Open, finishing at noon. She works and is paid for the hours; nothing is
    // drawn from her balance.
    key: 'yom-hazikaron', kind: 'short_day', name: 'יום הזיכרון',
    start: '2027-05-11', end: '2027-05-11', end_time: '12:00',
    hebrew: 'ד׳ אייר', note: 'הגן פתוח עד 12:00',
    emoji: '🇮🇱', color: '#8e44ad',
  },
  {
    key: 'yom-haatzmaut', kind: 'closure', name: 'יום העצמאות',
    start: '2027-05-12', end: '2027-05-12',
    hebrew: 'ה׳ אייר', return_note: 'חזרה לגן: יום חמישי, 13.5',
    emoji: '🎉', color: '#e84393',
  },
  {
    key: 'shavuot', kind: 'closure', name: 'שבועות',
    start: '2027-06-10', end: '2027-06-11',
    hebrew: 'ה׳ – ו׳ סיון', return_note: 'חזרה לגן: יום ראשון, 13.6',
    emoji: '🌸', color: '#ff6f91',
  },
  {
    key: 'graduation', kind: 'employer', name: 'מסיבת סיום הגן',
    start: '2027-07-09', end: '2027-07-09',
    note: 'אירוע מיוחד — הגן סגור', emoji: '🎓', color: '#00a8cc',
  },
  {
    // Two different days wearing one name, so they are two rows: Thursday the
    // gan runs and finishes at 15:00, Friday it is shut and we absorb it.
    key: 'staff-bonding-thu', kind: 'short_day', name: 'יום גיבוש צוות',
    start: '2027-07-15', end: '2027-07-15', end_time: '15:00',
    note: 'הגן פתוח עד 15:00', emoji: '🧑‍🏫', color: '#06d6a0',
  },
  {
    key: 'staff-bonding-fri', kind: 'employer', name: 'יום גיבוש צוות',
    start: '2027-07-16', end: '2027-07-16',
    note: 'הגן סגור', emoji: '🧑‍🏫', color: '#06d6a0',
  },
];

/** The note every parent sees under the list. */
const FOOTER_5787 = 'בימים של מסיבות בגן — הגן מסתיים בשעה 13:00';

const CALENDARS = {
  [YEAR_5787]: { entries: CALENDAR_5787, footer: FOOTER_5787 },
  [YEAR_5787_HEBREW]: { entries: CALENDAR_5787, footer: FOOTER_5787 },
};

/**
 * Tolerant on the way in, exact on the way out.
 *
 * The year turns up in three shapes depending on who is asking: '2026-2027',
 * 'תשפ״ז', and the display form '2026-2027 תשפ״ז' that formatAcademicYear
 * builds. All three mean one year, and refusing two of them is how a button
 * ends up telling a manager the year does not exist.
 */
function calendarFor(academicYear) {
  const raw = String(academicYear || '').trim();
  if (CALENDARS[raw]) return CALENDARS[raw];
  const range = raw.split(/\s+/)[0];
  return CALENDARS[range] || null;
}

/** The stored key for whatever the caller called the year. */
function normalizeYearKey(academicYear) {
  const raw = String(academicYear || '').trim();
  if (raw === YEAR_5787_HEBREW) return YEAR_5787;
  return raw.split(/\s+/)[0] || YEAR_5787;
}

/**
 * Turn one calendar row into the document that actually stores it.
 * Returns { model: 'Holiday'|'SpecialDay', doc }.
 */
function toDocument(entry, branchId, academicYear) {
  const common = {
    name: entry.name,
    hebrew: entry.hebrew || '',
    note: entry.note || '',
    return_note: entry.return_note || '',
    emoji: entry.emoji || '',
    color: entry.color || '',
    sort_order: CALENDAR_5787.indexOf(entry),
  };

  if (entry.kind === 'employer') {
    return {
      model: 'SpecialDay',
      doc: {
        ...common,
        date: entry.start,
        branch_id: branchId,
        academic_year: academicYear,
        // The employer shut the gan, so a global employee is not docked. An
        // hourly employee punched nothing and is not credited — she is neither
        // paid for a day she did not work nor charged for one.
        pay_global: true,
        pay_hourly: false,
      },
    };
  }

  return {
    model: 'Holiday',
    doc: {
      ...common,
      branch_id: branchId,
      academic_year: academicYear,
      start_date: new Date(`${entry.start}T00:00:00.000Z`),
      end_date: new Date(`${entry.end}T00:00:00.000Z`),
      kind: entry.kind === 'short_day' ? 'short_day' : 'closure',
      end_time: entry.end_time || '',
      is_half_day: false,
      is_custom: false,
    },
  };
}

/**
 * The whole year for one branch, as one list, whichever model each row lives in.
 *
 * Merged here rather than in each caller: a parent's screen and the office
 * screen must not be able to disagree about whether the gan is open, and the
 * only way to guarantee that is for both to read the same function.
 */
async function readCalendar(branchId, academicYear) {
  const { Holiday, SpecialDay } = require('../models');

  const ymd = (d) => new Date(d).toISOString().slice(0, 10);
  const [holidays, specials] = await Promise.all([
    Holiday.find({ branch_id: branchId, academic_year: academicYear }).lean(),
    SpecialDay.find({
      academic_year: academicYear,
      $or: [{ branch_id: null }, { branch_id: branchId }],
    }).lean(),
  ]);

  const rows = [
    ...holidays.map((h) => ({
      id: String(h._id),
      kind: h.kind === 'short_day' ? 'short_day' : 'closure',
      name: h.name,
      start: ymd(h.start_date),
      end: ymd(h.end_date),
      end_time: h.end_time || '',
      hebrew: h.hebrew || '',
      note: h.note || '',
      return_note: h.return_note || '',
      emoji: h.emoji || '',
      color: h.color || '',
      sort_order: h.sort_order || 0,
    })),
    ...specials.map((d) => ({
      id: String(d._id),
      kind: 'employer',
      name: d.name,
      start: d.date,
      end: d.date,
      end_time: '',
      hebrew: d.hebrew || '',
      note: d.note || '',
      return_note: d.return_note || '',
      emoji: d.emoji || '',
      color: d.color || '',
      sort_order: d.sort_order || 0,
    })),
  ];

  // By date, because that is the order a person reads a year in. sort_order
  // only decides ties, which is what two rows on the same day need.
  rows.sort((a, b) => a.start.localeCompare(b.start) || (a.sort_order - b.sort_order));
  return {
    academic_year: academicYear,
    footer: (calendarFor(academicYear) || {}).footer || '',
    entries: rows,
  };
}

/** Is the gan closed on `ymd`, and if it is open late-starting, until when? */
function statusOn(calendar, ymd) {
  for (const e of calendar.entries || []) {
    if (ymd < e.start || ymd > e.end) continue;
    if (e.kind === 'short_day') return { open: true, until: e.end_time, name: e.name };
    return { open: false, name: e.name, kind: e.kind };
  }
  return { open: true };
}

module.exports = {
  YEAR_5787, YEAR_5787_HEBREW, CALENDAR_5787, FOOTER_5787,
  calendarFor, normalizeYearKey, toDocument, readCalendar, statusOn,
};
