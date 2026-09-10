/**
 * The תינוקייה: which classrooms are one, and what the board offers to choose
 * from.
 *
 * Only the infant rooms need a daily board. A three-year-old's parent does not
 * want a bottle log, and the staff of the older rooms should not be handed a
 * screen that asks them for one.
 *
 * Deciding which room is a תינוקייה is the awkward part. `Classroom.category`
 * is exactly the right field and it is filled in on one classroom out of
 * thirty-eight; the names are filled in on all of them and say "תינוקייה א",
 * "תינוקייה ב". So: the category decides when it is set, and the name decides
 * otherwise. Setting the category on the real rooms would make this exact —
 * that is a data cleanup worth doing, and until it happens this reads the
 * seventeen active infants correctly rather than three.
 */

const { Classroom, Setting } = require('../models');

const NURSERY_CATEGORY = 'תינוקייה';
const NURSERY_NAME_RE = /תינוקי/;

/**
 * A classroom's level — תינוקייה, צעירים or בוגרים — however we can get it.
 *
 * `Classroom.category` is the right field and it is filled in on ONE classroom
 * out of thirty-eight. The names are filled in on all of them and say what the
 * room is. So the category decides when it is set and the name decides
 * otherwise, and this lives in one function because more than one feature now
 * depends on the answer: the daily board is infant-only, and a gift round
 * assigns a product per level. Answered separately in two places, the two would
 * disagree the day somebody finally fills the field in.
 *
 * Returns null when neither says anything, and callers must treat that as
 * "unknown" rather than as a level.
 */
const NAME_TO_CATEGORY = [
  [/תינוקי/, 'תינוקייה'],
  [/צעיר/, 'צעירים'],
  [/בוגר/, 'בוגרים'],
];

function classroomCategory(classroom) {
  if (!classroom) return null;
  if (classroom.category) return classroom.category;
  const name = String(classroom.name || '');
  for (const [re, category] of NAME_TO_CATEGORY) {
    if (re.test(name)) return category;
  }
  return null;
}

/** Is this classroom an infant room? */
function isNurseryClassroom(classroom) {
  if (!classroom) return false;
  if (classroom.category) return classroom.category === NURSERY_CATEGORY;
  return NURSERY_NAME_RE.test(String(classroom.name || ''));
}

/** Every active infant room — each branch's newest, so year rollover never
 *  shows the same room twice and never hides a branch that hasn't rolled yet. */
async function nurseryClassrooms(filter = {}) {
  const { dedupeNewest } = require('./classroomList');
  const rooms = await Classroom.find({ is_active: true, ...filter })
    .populate('branch_id', 'name')
    .sort({ name: 1 })
    .lean();
  return dedupeNewest(rooms.filter(isNurseryClassroom));
}

/**
 * How much of a day this room keeps: 'full' or 'light'.
 *
 * 'full' is the board as it has always been — the bottle log, the naps, the
 * nappies, and the four fields the family fills in from home before the child
 * arrives. It belongs to the rooms whose day is actually made of those things:
 * תינוקייה and צעירים.
 *
 * 'light' is everything else. A four-year-old's parent has no bottle to read
 * and the staff of that room should not be handed a screen asking for one —
 * but the parent still wants the day, and the day for them is three things:
 * what the kitchen served, what the class did, and the photographs. So the
 * older rooms get a board of one line for the whole class rather than no
 * board at all, which is what they had until now.
 *
 * An unplaced or uncategorised room falls to 'light' deliberately. The light
 * board asks nothing of anybody and shows what happens to exist; the full one
 * would present a family with an empty bottle log for a child who does not
 * drink from one.
 */
const FULL_BOARD_CATEGORIES = new Set(['תינוקייה', 'צעירים']);

function boardKind(classroom) {
  return FULL_BOARD_CATEGORIES.has(classroomCategory(classroom)) ? 'full' : 'light';
}

/**
 * Every active room the daily board covers — which is now all of them.
 *
 * Same de-duplication as the infant list: a branch mid-rollover holds this
 * year's room and last year's under the same name, and the board must offer
 * one of them.
 */
async function boardClassrooms(filter = {}) {
  const { dedupeNewest } = require('./classroomList');
  const rooms = await Classroom.find({ is_active: true, ...filter })
    .populate('branch_id', 'name')
    .sort({ name: 1 })
    .lean();
  return dedupeNewest(rooms);
}

/**
 * The lists the board offers.
 *
 * These came from a "הגדרות" tab the staff edited themselves, and they must
 * stay editable — the bottle sizes and the what-to-bring list are the gan's
 * business, not the code's. They live in Setting under one key, seeded with
 * what the sheet held so the board is usable the day it ships rather than
 * empty until somebody fills a form.
 *
 * Portions are stored as they are shown. The sheet held 0.25 and rendered 25%;
 * carrying the fraction through would mean every reader re-deciding how to
 * display it.
 */
const DEFAULT_OPTIONS = {
  meal_amounts: ['0%', '25%', '50%', '75%', '100%'],
  formula_amounts: ['20', '30', '40', '50', '60', '70', '80', '90', '100', '120', '140', '160', '180', '200'],
  diapers: ['0', '1', '2', '3', '4', '5'],
  missing: [
    'תמ״ל', 'מגבונים', 'משחת החתלה', 'בגדי החלפה', 'טטרה',
    'סינרים', 'טיטולים', 'מוצץ', 'סדין', 'בקבוקים', 'גרביים',
  ],
  // The hours each picker offers. A morning nap does not start at 18:00, and a
  // list that says it does is a list somebody will mis-tap.
  hours: {
    home_wake: ['04', '05', '06', '07', '08', '09'],
    home_meal: ['04', '05', '06', '07', '08', '09', '10'],
    sleep_morning: ['08', '09', '10', '11'],
    sleep_noon: ['11', '12', '13', '14', '15', '16'],
  },
  minutes: ['00', '05', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55'],
};

/**
 * The menu's categories and the dishes each offers.
 *
 * Meals are keyed in English because the code branches on them; the categories
 * and the dishes are the gan's Hebrew, untouched.
 */
const DEFAULT_MENU = {
  breakfast: {
    label: 'ארוחת בוקר',
    categories: {
      'חלבון': ['טונה', 'ביצה קשה', 'מקושקשת', 'אצבעות טונה', 'יוגורט', 'קוטג׳', 'גבינה צהובה', 'טחינה'],
      'פחמימה': ['כריך חומוס', 'כריך גבינה', 'כריך טונה', 'פשטידה', 'לביבות', 'פנקייקים'],
      'ירק': ['אבוקדו', 'מלפפון', 'עגבניה', 'פלפל'],
      'קבוע': ['פירות טחונים'],
    },
  },
  lunch: {
    label: 'ארוחת צהריים',
    categories: {
      'חלבון': ['קציצות דגים', 'קציצות בקר', 'קציצות עוף', 'קציצות טונה', 'קציצות ירק', 'קציצות עדשים', 'בולונז', 'תבשיל עדשים'],
      'פחמימה': ['בורגול', 'אורז', 'פסטה', 'קוסקוס', 'מג׳דרה', 'תפוח אדמה', 'איטריות', 'אורז + אטריות'],
      'ירק': ['שעועית ירוקה', 'שעועית צהובה', 'סלק', 'גזר', 'בטטה', 'מרק ירקות'],
      'קבוע': ['מרק ירקות טחון'],
    },
  },
  snack: {
    label: 'ארוחת 4',
    categories: {
      'כריך': ['ממרח חלבה', 'ממרח תמרים', 'טחינה עם סילאן', 'גבינה', 'חומוס'],
      'פרי': ['תפוזים', 'בננה', 'תפוח', 'מלון', 'אבטיח'],
    },
  },
};

const OPTIONS_KEY = 'nursery_board_options';
const MENU_KEY = 'nursery_board_menu';

/**
 * Read a configuration key, seeding it from the default on first use.
 *
 * Seeded rather than merged: once the gan has edited a list, the code's opinion
 * about it stops being relevant, and quietly re-adding a bottle size somebody
 * deliberately removed is worse than being out of date.
 */
async function readConfig(key, fallback) {
  const doc = await Setting.findOne({ key }).lean();
  if (doc && doc.value) return doc.value;
  await Setting.updateOne({ key }, { $set: { key, value: fallback } }, { upsert: true });
  return fallback;
}

const getOptions = () => readConfig(OPTIONS_KEY, DEFAULT_OPTIONS);
const getMenu = () => readConfig(MENU_KEY, DEFAULT_MENU);

/** Today, as the board's date key. Local time — a day here is a calendar day. */
function todayKey(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** YYYY-MM-DD, or null. Guards a date arriving from a query string. */
function normalizeDateKey(raw) {
  const s = String(raw || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

module.exports = {
  isNurseryClassroom, nurseryClassrooms, classroomCategory,
  boardKind, boardClassrooms,
  getOptions, getMenu, todayKey, normalizeDateKey,
  DEFAULT_OPTIONS, DEFAULT_MENU, OPTIONS_KEY, MENU_KEY,
  NURSERY_CATEGORY,
};
