const { Child, Classroom, DailyLog, DailyMenu, Setting } = require('../models');
const nursery = require('../services/nursery.service');

/**
 * The תינוקייה's daily board.
 *
 * One screen, read and written all day by whoever is in the room, from a
 * phone, usually one-handed. Two things follow from that and shape everything
 * here.
 *
 * The whole board is one request. Fourteen children with three meals, two
 * naps, nappies, a list of what to bring and a note is a lot of small values,
 * and fetching them per child would be forty requests over the gan's wifi
 * before anybody has tapped anything.
 *
 * A write is one field. The staff do not fill a form and submit it; they tap
 * "50%" as they walk past. So every write is a patch of exactly what changed,
 * and a patch that loses the race with a colleague's overwrites one field
 * rather than the day.
 */

/** The classrooms this user may see, respecting branch scope. */
async function visibleClassrooms(user) {
  const rooms = await nursery.nurseryClassrooms();
  if (user.role === 'system_admin' || user.role === 'accountant') return rooms;

  const managed = (user.managed_branch_ids || []).map(String);
  const own = user.branch_id ? [String(user.branch_id)] : [];
  const allowed = new Set([...managed, ...own].filter(Boolean));
  if (allowed.size === 0) return rooms;

  return rooms.filter(r => allowed.has(String(r.branch_id?._id || r.branch_id)));
}

/**
 * Everything the board needs for one classroom on one day.
 *
 * The children come from the roster and the logs are matched onto them, rather
 * than the other way round: a child with nothing recorded yet must still
 * appear — an empty row is the day's work, not an absence of data.
 */
async function board(req, res) {
  const rooms = await visibleClassrooms(req.user);
  if (rooms.length === 0) {
    return res.json({ classrooms: [], children: [], date: nursery.todayKey() });
  }

  const requested = String(req.query.classroom || '');
  const room = rooms.find(r => String(r._id) === requested) || rooms[0];
  const date = nursery.normalizeDateKey(req.query.date) || nursery.todayKey();

  const children = await Child.find({ classroom_id: room._id, is_active: true })
    .select('child_name birth_date phone parent_name classroom_id')
    .sort({ birth_date: -1, child_name: 1 })
    .lean();

  const logs = await DailyLog.find({
    date,
    child_id: { $in: children.map(c => c._id) },
  }).lean();
  const byChild = new Map(logs.map(l => [String(l.child_id), l]));

  const branchId = room.branch_id?._id || room.branch_id;
  const [options, menu, menuDoc] = await Promise.all([
    nursery.getOptions(),
    nursery.getMenu(),
    DailyMenu.findOne({ branch_id: branchId, date }).lean(),
  ]);

  return res.json({
    date,
    today: nursery.todayKey(),
    classrooms: rooms.map(r => ({
      id: r._id,
      name: r.name,
      branch: r.branch_id?.name || '',
      academic_year: r.academic_year,
    })),
    classroom: { id: room._id, name: room.name, branch: room.branch_id?.name || '', branch_id: branchId },
    options,
    menu,
    menu_selections: menuDoc?.selections || {},
    children: children.map(c => ({
      id: c._id,
      name: c.child_name,
      birth_date: c.birth_date,
      log: byChild.get(String(c._id)) || null,
    })),
  });
}

/**
 * The fields a staff patch may set, and how to read each one.
 *
 * A whitelist rather than a merge of the body: the board is written from a
 * phone by whoever is holding it, and "whatever the client sent" is not a
 * specification. Times are checked against HH:MM, so a broken picker writes
 * nothing rather than something the parent's report will later print.
 */
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const str = (v, max = 300) => String(v ?? '').trim().slice(0, max);
const time = (v) => {
  const s = str(v, 5);
  return s === '' || TIME_RE.test(s) ? s : null;
};

const FIELDS = {
  attendance: (v) => (['', 'הגיע', 'חסר'].includes(str(v)) ? str(v) : null),
  'home.wake_time': time,
  'home.meal_time': time,
  'home.meal_amount': (v) => str(v, 60),
  'home.parent_note': (v) => str(v, 500),
  'meals.breakfast.amount': (v) => str(v, 20),
  'meals.breakfast.formula': (v) => str(v, 20),
  'meals.lunch.amount': (v) => str(v, 20),
  'meals.lunch.formula': (v) => str(v, 20),
  'meals.snack.amount': (v) => str(v, 20),
  'meals.snack.formula': (v) => str(v, 20),
  'sleep.morning.start': time,
  'sleep.morning.end': time,
  'sleep.noon.start': time,
  'sleep.noon.end': time,
  diapers: (v) => str(v, 20),
  staff_note: (v) => str(v, 1000),
  missing: (v) => (Array.isArray(v) ? v.map(x => str(x, 40)).filter(Boolean).slice(0, 30) : null),
};

/**
 * Record one child's day.
 *
 * Upserted, so the first tap of the morning creates the row and there is no
 * separate "open the day" step for somebody to forget. The child is re-checked
 * against the infant rooms on every call — the classroom in the URL is not
 * evidence, and a board left open in a tab overnight must not write into a
 * room the user has since lost access to.
 */
async function updateLog(req, res) {
  const date = nursery.normalizeDateKey(req.body?.date) || nursery.todayKey();

  const child = await Child.findOne({ _id: req.params.childId, is_active: true })
    .populate('classroom_id', 'name category branch_id')
    .lean();
  if (!child) return res.status(404).json({ error: 'לא נמצא' });
  if (!nursery.isNurseryClassroom(child.classroom_id)) {
    return res.status(400).json({ error: 'הלוח היומי קיים לתינוקייה בלבד' });
  }

  const rooms = await visibleClassrooms(req.user);
  if (!rooms.some(r => String(r._id) === String(child.classroom_id?._id))) {
    return res.status(403).json({ error: 'אין לך הרשאה לכיתה זו' });
  }

  const set = {};
  for (const [path, parse] of Object.entries(FIELDS)) {
    if (!(path in (req.body || {}))) continue;
    const value = parse(req.body[path]);
    if (value === null) return res.status(400).json({ error: `ערך לא תקין בשדה ${path}` });
    set[path] = value;
  }
  if (Object.keys(set).length === 0) return res.json({ ok: true, changed: 0 });

  set.child_name = child.child_name;
  set.classroom_id = child.classroom_id?._id || null;
  set.branch_id = child.classroom_id?.branch_id || null;
  set.updated_by = req.user.id;
  set.updated_by_name = req.user.full_name || '';

  const log = await DailyLog.findOneAndUpdate(
    { child_id: child._id, date },
    { $set: set, $setOnInsert: { child_id: child._id, date } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

  return res.json({ ok: true, changed: Object.keys(set).length, log });
}

/**
 * Set the day's menu for a branch.
 *
 * Replaces the whole selection map rather than patching one dish: the menu is
 * edited on one screen by one person deciding what today's meals are, and a
 * per-dish patch would let two half-finished menus interleave into a third
 * nobody chose.
 */
async function setMenu(req, res) {
  const date = nursery.normalizeDateKey(req.body?.date) || nursery.todayKey();
  const branchId = req.body?.branch_id;
  if (!branchId) return res.status(400).json({ error: 'חסר סניף' });

  const rooms = await visibleClassrooms(req.user);
  if (!rooms.some(r => String(r.branch_id?._id || r.branch_id) === String(branchId))) {
    return res.status(403).json({ error: 'אין לך הרשאה לסניף זה' });
  }

  const menu = await nursery.getMenu();
  const incoming = req.body?.selections || {};
  const clean = {};

  // Only meal.category keys the menu actually defines, and only dishes it
  // offers. A stale tab holding last term's categories writes nothing.
  for (const [mealKey, meal] of Object.entries(menu)) {
    for (const [category, dishes] of Object.entries(meal.categories || {})) {
      const key = `${mealKey}.${category}`;
      const chosen = incoming[key];
      if (!Array.isArray(chosen)) continue;
      const valid = chosen.map(String).filter(d => dishes.includes(d));
      if (valid.length) clean[key] = valid;
    }
  }

  await DailyMenu.findOneAndUpdate(
    { branch_id: branchId, date },
    {
      $set: {
        selections: clean,
        updated_by: req.user.id,
        updated_by_name: req.user.full_name || '',
      },
      $setOnInsert: { branch_id: branchId, date },
    },
    { upsert: true, setDefaultsOnInsert: true }
  );

  return res.json({ ok: true, selections: clean });
}

/**
 * The lists the board offers, and the menu it offers them from.
 *
 * These came from a sheet tab the gan edited itself, and they have to stay
 * that way: the bottle sizes, the what-to-bring list and the dishes are the
 * kitchen's business, not the code's. Everything below exists to let them be
 * edited without letting a mistyped screen take the board down for every
 * branch at once.
 */

const LIST_KEYS = ['meal_amounts', 'formula_amounts', 'diapers', 'missing'];
const HOUR_KEYS = ['home_wake', 'home_meal', 'sleep_morning', 'sleep_noon'];

/** Trimmed, de-duplicated, empty entries dropped, and capped. */
function cleanList(value, { maxItems = 60, maxLen = 40 } = {}) {
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const raw of value) {
    if (typeof raw !== 'string' && typeof raw !== 'number') return null;
    const s = String(raw).trim().slice(0, maxLen);
    if (s && !out.includes(s)) out.push(s);
  }
  return out.slice(0, maxItems);
}

async function settings(_req, res) {
  const [options, menu] = await Promise.all([nursery.getOptions(), nursery.getMenu()]);
  return res.json({ options, menu, meal_keys: Object.keys(nursery.DEFAULT_MENU) });
}

/**
 * Save the option lists.
 *
 * Only the keys the board reads, and an empty list is refused rather than
 * saved: a field whose picker offers nothing is a field the staff cannot fill
 * in, and they would find that out mid-morning with a baby in one arm.
 */
async function saveOptions(req, res) {
  const current = await nursery.getOptions();
  const next = { ...current, hours: { ...current.hours } };
  const errors = [];

  for (const key of LIST_KEYS) {
    if (!(key in (req.body || {}))) continue;
    const list = cleanList(req.body[key], { maxLen: key === 'missing' ? 40 : 20 });
    if (!list) { errors.push(`${key}: ערך לא תקין`); continue; }
    if (list.length === 0) { errors.push(`${key}: הרשימה לא יכולה להיות ריקה`); continue; }
    next[key] = list;
  }

  if (req.body?.hours && typeof req.body.hours === 'object') {
    for (const key of HOUR_KEYS) {
      if (!(key in req.body.hours)) continue;
      const list = cleanList(req.body.hours[key], { maxItems: 24, maxLen: 2 });
      if (!list || list.some(h => !/^([01]\d|2[0-3])$/.test(h))) {
        errors.push(`שעות ${key}: ערך לא תקין`);
        continue;
      }
      if (list.length === 0) { errors.push(`שעות ${key}: הרשימה לא יכולה להיות ריקה`); continue; }
      next.hours[key] = list.sort();
    }
  }

  if ('minutes' in (req.body || {})) {
    const list = cleanList(req.body.minutes, { maxItems: 60, maxLen: 2 });
    if (!list || list.length === 0 || list.some(m => !/^[0-5]\d$/.test(m))) {
      errors.push('דקות: ערך לא תקין');
    } else {
      next.minutes = list.sort();
    }
  }

  if (errors.length) return res.status(400).json({ error: errors.join('. ') });

  await Setting.updateOne(
    { key: nursery.OPTIONS_KEY },
    { $set: { key: nursery.OPTIONS_KEY, value: next } },
    { upsert: true }
  );
  return res.json({ ok: true, options: next });
}

/**
 * Save the menu.
 *
 * The three meals are structural — the child card lays out breakfast, lunch
 * and the four o'clock, and the parent's screen names them — so their keys are
 * fixed and only their labels, categories and dishes are editable. Letting the
 * screen invent a fourth meal would produce a menu nothing renders.
 *
 * A category with no dishes is dropped rather than saved: it would render as a
 * heading with nothing under it on every screen that reads the menu.
 */
async function saveMenu(req, res) {
  const incoming = req.body?.menu;
  if (!incoming || typeof incoming !== 'object') {
    return res.status(400).json({ error: 'תפריט לא תקין' });
  }

  const current = await nursery.getMenu();
  const next = {};
  const errors = [];

  for (const mealKey of Object.keys(nursery.DEFAULT_MENU)) {
    const src = incoming[mealKey];
    const fallback = current[mealKey] || nursery.DEFAULT_MENU[mealKey];
    if (!src || typeof src !== 'object') { next[mealKey] = fallback; continue; }

    const label = String(src.label ?? fallback.label ?? mealKey).trim().slice(0, 40);
    if (!label) { errors.push(`${mealKey}: חסר שם לארוחה`); continue; }

    const categories = {};
    const rawCats = src.categories && typeof src.categories === 'object' ? src.categories : {};
    for (const [rawName, dishes] of Object.entries(rawCats)) {
      const name = String(rawName).trim().slice(0, 30);
      if (!name) continue;
      const list = cleanList(dishes, { maxItems: 60, maxLen: 40 });
      if (!list) { errors.push(`${label} / ${name}: ערך לא תקין`); continue; }
      if (list.length === 0) continue; // a heading with nothing under it
      categories[name] = list;
    }

    if (Object.keys(categories).length === 0) {
      errors.push(`${label}: צריכה להיות לפחות קטגוריה אחת עם מנות`);
      continue;
    }
    next[mealKey] = { label, categories };
  }

  if (errors.length) return res.status(400).json({ error: errors.join('. ') });

  await Setting.updateOne(
    { key: nursery.MENU_KEY },
    { $set: { key: nursery.MENU_KEY, value: next } },
    { upsert: true }
  );
  return res.json({ ok: true, menu: next });
}

module.exports = { board, updateLog, setMenu, settings, saveOptions, saveMenu };
