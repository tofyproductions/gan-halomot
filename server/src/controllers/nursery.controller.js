const { Child, Classroom, DailyLog, DailyMenu } = require('../models');
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

module.exports = { board, updateLog, setMenu };
