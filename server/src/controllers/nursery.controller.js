const { Child, Classroom, DailyLog, DailyMenu, ClassroomDay, Setting } = require('../models');
const { CLASSROOM_BOARD } = require('../constants/roles');
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

/**
 * The classrooms this user may see, respecting branch scope.
 *
 * ALL the active rooms now, not only the infant ones. The older rooms keep a
 * lighter day — one line for the whole class rather than a bottle log per
 * child — and which kind a room gets is `nursery.boardKind`, decided in one
 * place and sent to the screen rather than guessed there.
 */
async function visibleClassrooms(user) {
  const rooms = await nursery.boardClassrooms();

  // A board account is ONE room. Not its branch narrowed by a dropdown — the
  // room is the account's whole scope, and the list it is handed has one entry
  // so the screen cannot offer it a second. A board whose room was archived or
  // deleted gets nothing rather than falling through to the branch below,
  // which would turn a stale tablet into a window on every class in the gan.
  if (user.role === CLASSROOM_BOARD) {
    const mine = String(user.classroom_id || '');
    return mine ? rooms.filter(r => String(r._id) === mine) : [];
  }

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

  const kind = nursery.boardKind(room);

  // A light room has no per-child day to fetch. Reading the roster anyway
  // would be twenty documents nothing on the screen displays.
  // The room's own children, plus the ones CARRIED on this board: a child who
  // moved up to פעוטות and was kept here for a while so the family still
  // gets the bottle log. They are drawn with a mark and a date, and three days
  // before the date the card asks whether to keep going.
  const today = nursery.todayKey();
  const children = kind === 'full'
    ? await Child.find({
      is_active: true,
      $or: [
        { classroom_id: room._id },
        { 'board_extension.classroom_id': room._id, 'board_extension.until': { $gte: new Date(`${today}T00:00:00+03:00`) } },
      ],
    })
      .select('child_name birth_date phone parent_name classroom_id board_extension')
      .populate('classroom_id', 'name')
      .sort({ birth_date: -1, child_name: 1 })
      .lean()
    : [];

  // Open move requests, so the button that asked is not offered twice and
  // the card can say the manager has it.
  const { ClassroomMoveRequest } = require('../models');
  const pendingMoves = children.length
    ? await ClassroomMoveRequest.find({ child_id: { $in: children.map(c => c._id) }, status: 'pending' })
      .select('child_id to_name').lean()
    : [];
  const pendingByChild = new Map(pendingMoves.map(m => [String(m.child_id), m]));

  const logs = children.length
    ? await DailyLog.find({ date, child_id: { $in: children.map(c => c._id) } }).lean()
    : [];
  // `.lean()` hands back the stored document, not the schema's idea of it: a
  // row written before `sync_conflicts` existed comes back without the key at
  // all rather than with its `[]` default. Normalised here, the same way
  // services/sheet-sync/run.js already has to, so the board can always show
  // what a conflict rejected without every reader re-deciding what a missing
  // key means.
  // Rows the rule never saw — written before it existed, or pulled in by the
  // sheet sync — settle here, on read, and are written back so the parent's
  // live view and the history agree with what the board shows.
  await Promise.all(logs.map(async (l) => {
    const fix = nursery.settleAttendance(l);
    if (!fix) return;
    Object.assign(l, fix);
    await DailyLog.updateOne({ _id: l._id }, { $set: fix });
  }));
  const byChild = new Map(logs.map(l => [String(l.child_id), {
    ...l,
    sync_conflicts: Array.isArray(l.sync_conflicts) ? l.sync_conflicts : [],
  }]));

  const branchId = room.branch_id?._id || room.branch_id;
  const [options, menu, menuDoc, classDay] = await Promise.all([
    nursery.getOptions(),
    nursery.getMenu(),
    DailyMenu.findOne({ branch_id: branchId, date }).lean(),
    ClassroomDay.findOne({ classroom_id: room._id, date }).lean(),
  ]);

  return res.json({
    date,
    today: nursery.todayKey(),
    classrooms: rooms.map(r => ({
      id: r._id,
      name: r.name,
      branch: r.branch_id?.name || '',
      academic_year: r.academic_year,
      board: nursery.boardKind(r),
    })),
    classroom: {
      id: room._id,
      name: room.name,
      branch: room.branch_id?.name || '',
      branch_id: branchId,
      board: kind,
    },
    options,
    menu,
    menu_selections: menuDoc?.selections || {},
    // The whole of a light room's own day. Sent for every room so the screen
    // never has to ask twice; the full rooms simply have nothing in it.
    activity: classDay?.activity || '',
    activity_updated_by: classDay?.updated_by_name || '',
    children: children.map(c => {
      const carried = String(c.classroom_id?._id || c.classroom_id) !== String(room._id);
      const until = carried && c.board_extension?.until ? new Date(c.board_extension.until) : null;
      const daysLeft = until ? Math.ceil((until - new Date(`${today}T00:00:00+03:00`)) / 86400000) : null;
      const pending = pendingByChild.get(String(c._id));
      return {
        id: c._id,
        name: c.child_name,
        birth_date: c.birth_date,
        log: byChild.get(String(c._id)) || null,
        // Marked as פעוט/ה with the room they actually belong to now.
        carried,
        own_classroom: carried ? (c.classroom_id?.name || '') : '',
        board_until: until ? until.toISOString().slice(0, 10) : null,
        // "Ask me" — the last three days of the extension, the card asks
        // whether to keep the child on for another month.
        board_expiring: daysLeft !== null && daysLeft <= 3,
        pending_move: pending ? { to: pending.to_name } : null,
      };
    }),
  });
}

/**
 * What the class did today, for one room.
 *
 * Replaces the line rather than patching it: it is one sentence written by one
 * person, and there is nothing in it for two writers to interleave.
 *
 * The room is re-checked against what this user may see on every call. A board
 * left open in a tab overnight must not write into a room its owner has since
 * lost — the same rule the per-child log already follows.
 */
async function setClassroomDay(req, res) {
  const date = nursery.normalizeDateKey(req.body?.date) || nursery.todayKey();
  const roomId = req.body?.classroom_id;
  if (!roomId) return res.status(400).json({ error: 'חסרה כיתה' });

  const rooms = await visibleClassrooms(req.user);
  const room = rooms.find(r => String(r._id) === String(roomId));
  if (!room) return res.status(403).json({ error: 'אין לך הרשאה לכיתה זו' });

  const activity = String(req.body?.activity ?? '').trim().slice(0, 2000);

  const doc = await ClassroomDay.findOneAndUpdate(
    { classroom_id: room._id, date },
    {
      $set: {
        activity,
        branch_id: room.branch_id?._id || room.branch_id || null,
        updated_by: req.user.id,
        updated_by_name: req.user.full_name || '',
      },
      $setOnInsert: { classroom_id: room._id, date },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

  return res.json({ ok: true, activity: doc.activity || '', updated_by: doc.updated_by_name || '' });
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
  if (nursery.boardKindForChild(child, child.classroom_id) !== 'full') {
    return res.status(400).json({ error: 'הדיווח האישי קיים לתינוקייה בלבד' });
  }

  // The board this child's day lives on: their own room, or the room they are
  // carried on. A פעוט kept on the תינוקייה board is written by the
  // תינוקייה staff, who are the ones the family is still talking to.
  const boardRoomId = nursery.extensionActive(child)
    ? String(child.board_extension.classroom_id)
    : String(child.classroom_id?._id);
  const rooms = await visibleClassrooms(req.user);
  if (!rooms.some(r => String(r._id) === boardRoomId)) {
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

  // Looking at both values and choosing one IS the resolution. Leaving the
  // note up after the teacher has acted would make it furniture, and the next
  // person would learn to ignore it. Captured before the bookkeeping fields
  // below join `set`, so only the paths a human actually meant to change are
  // the ones a conflict note gets pulled for.
  const touched = Object.keys(set);

  // Attendance the system can tell on its own — see nursery.inferAttendance.
  const existing = await DailyLog.findOne({ child_id: child._id, date }).select('attendance attendance_auto').lean();
  const inferred = nursery.inferAttendance(existing, {
    explicit: 'attendance' in set ? set.attendance : undefined,
    staffData: touched.some(p => p !== 'attendance' && !p.startsWith('home.')),
  });
  if (inferred) Object.assign(set, inferred);

  set.child_name = child.child_name;
  set.classroom_id = child.classroom_id?._id || null;
  set.branch_id = child.classroom_id?.branch_id || null;
  set.updated_by = req.user.id;
  set.updated_by_name = req.user.full_name || '';

  const update = { $set: set };
  if (touched.length) update.$pull = { sync_conflicts: { field: { $in: touched } } };

  const log = await DailyLog.findOneAndUpdate(
    { child_id: child._id, date },
    { ...update, $setOnInsert: { child_id: child._id, date } },
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


/* ------------------------------------------------------------------ *
 *  Children carried on a board that is not their room's
 * ------------------------------------------------------------------ */

const EXTENSION_MONTHS_AT_MOVE = 3;
const EXTENSION_MONTHS_RENEW = 1;

const addMonths = (from, n) => {
  const d = new Date(from);
  d.setMonth(d.getMonth() + n);
  d.setHours(23, 59, 59, 999);
  return d;
};

/** The room, if this caller may run its board. */
async function boardRoomFor(req, classroomId) {
  const rooms = await visibleClassrooms(req.user);
  const room = rooms.find(r => String(r._id) === String(classroomId));
  if (!room) return { error: 'אין לך הרשאה לכיתה זו', status: 403 };
  if (nursery.boardKind(room) !== 'full') return { error: 'לכיתה הזו אין לוח אישי', status: 400 };
  return { room };
}

/**
 * GET /api/nursery/board/candidates?classroom=
 *
 * The children of the SAME BRANCH who could be carried on this board and are
 * not: the פעוטות who just moved up. Same branch only — a תינוקייה in כפר סבא
 * has no business carrying a child from תל אביב.
 */
async function boardCandidates(req, res) {
  const { room, error, status } = await boardRoomFor(req, req.query.classroom);
  if (error) return res.status(status).json({ error });
  const branchId = room.branch_id?._id || room.branch_id;
  const rooms = await Classroom.find({ branch_id: branchId, is_active: true, _id: { $ne: room._id } })
    .select('name category').lean();
  // Only the rooms with no board of their own. Offering a child from another
  // תינוקייה would put one child on two boards.
  const eligible = rooms.filter(r => nursery.boardKind(r) === 'none');
  const today = new Date(`${nursery.todayKey()}T00:00:00+03:00`);
  const kids = await Child.find({
    classroom_id: { $in: eligible.map(r => r._id) },
    is_active: true,
    $or: [
      { 'board_extension.classroom_id': null },
      { 'board_extension.until': { $lt: today } },
    ],
  }).select('child_name birth_date classroom_id').populate('classroom_id', 'name').sort({ child_name: 1 }).lean();
  res.json({
    candidates: kids.map(k => ({ id: k._id, name: k.child_name, classroom: k.classroom_id?.name || '' })),
  });
}

/**
 * POST /api/nursery/board/extend  { classroom, child_id, months? }
 *
 * Put a child on this board, or keep them on it. Three months when they are
 * added; one month on a renewal, which is what the card offers three days
 * before the end. The date is set from TODAY on a renewal, not stacked on the
 * old end — "one more month" means from now.
 */
async function extendOnBoard(req, res) {
  const { room, error, status } = await boardRoomFor(req, req.body?.classroom);
  if (error) return res.status(status).json({ error });
  const child = await Child.findOne({ _id: req.body?.child_id, is_active: true }).populate('classroom_id', 'branch_id name');
  if (!child) return res.status(404).json({ error: 'לא נמצא' });
  const roomBranch = String(room.branch_id?._id || room.branch_id);
  if (String(child.classroom_id?.branch_id) !== roomBranch) {
    return res.status(400).json({ error: 'הילד/ה אינו/ה בסניף של הכיתה הזו' });
  }
  if (String(child.classroom_id?._id) === String(room._id)) {
    return res.status(400).json({ error: 'הילד/ה כבר בכיתה הזו' });
  }
  const renewing = nursery.extensionActive(child) && String(child.board_extension.classroom_id) === String(room._id);
  const months = Number(req.body?.months) || (renewing ? EXTENSION_MONTHS_RENEW : EXTENSION_MONTHS_AT_MOVE);
  child.board_extension = {
    classroom_id: room._id,
    until: addMonths(new Date(), months),
    set_by: req.user?.id || null,
    set_at: new Date(),
  };
  await child.save();
  res.json({ ok: true, until: child.board_extension.until.toISOString().slice(0, 10), months });
}

/** POST /api/nursery/board/release  { classroom, child_id } — "no, let them go". */
async function releaseFromBoard(req, res) {
  const { room, error, status } = await boardRoomFor(req, req.body?.classroom);
  if (error) return res.status(status).json({ error });
  const child = await Child.findOne({ _id: req.body?.child_id, 'board_extension.classroom_id': room._id });
  if (!child) return res.status(404).json({ error: 'הילד/ה אינו/ה מורחב/ת על הלוח הזה' });
  child.board_extension = { classroom_id: null, until: null, set_by: req.user?.id || null, set_at: new Date() };
  await child.save();
  res.json({ ok: true });
}

/**
 * POST /api/nursery/board/move-request  { classroom, child_id, keep_on_board }
 *
 * "העבר לכיתת הפעוטות". Not the move — the ask. The room decides the fee, so
 * the branch manager decides the room; this files the request and tells her.
 * The target is the branch's צעירים room for the child's year; if there is
 * more than one it is whichever is named first, and the manager can always
 * drag the child elsewhere afterwards.
 */
async function requestMove(req, res) {
  const { room, error, status } = await boardRoomFor(req, req.body?.classroom);
  if (error) return res.status(status).json({ error });
  const child = await Child.findOne({ _id: req.body?.child_id, is_active: true, classroom_id: room._id })
    .populate('classroom_id', 'name branch_id');
  if (!child) return res.status(404).json({ error: 'הילד/ה אינו/ה בכיתה הזו' });

  const { ClassroomMoveRequest, User } = require('../models');
  const open = await ClassroomMoveRequest.findOne({ child_id: child._id, status: 'pending' }).lean();
  if (open) return res.status(409).json({ error: 'כבר קיימת בקשת מעבר שממתינה לאישור' });

  const branchId = room.branch_id?._id || room.branch_id;
  const targets = await Classroom.find({ branch_id: branchId, is_active: true, academic_year: child.academic_year })
    .select('name category').sort({ name: 1 }).lean();
  const target = targets.find(r => nursery.classroomCategory(r) === 'צעירים');
  if (!target) {
    return res.status(400).json({ error: `לא נמצאה כיתת פעוטות לשנת ${child.academic_year} בסניף הזה` });
  }

  const request = await ClassroomMoveRequest.create({
    child_id: child._id,
    child_name: child.child_name,
    branch_id: branchId,
    from_classroom_id: room._id,
    to_classroom_id: target._id,
    from_name: room.name,
    to_name: target.name,
    keep_on_board: req.body?.keep_on_board === true || req.body?.keep_on_board === 'true',
    requested_by: req.user?.id || null,
    requested_by_name: req.user?.full_name || '',
  });

  // The branch manager gets it in the app; nobody else needs to.
  const notificationService = require('../services/notification.service');
  notificationService.branchManagerIds(branchId).then((ids) => {
    ids.forEach((recipient_id) => notificationService.createEvent({
      type: 'child_move_request', ref_collection: 'ClassroomMoveRequest', ref_id: request._id, recipient_id,
      title: 'בקשת מעבר כיתה ממתינה לאישור',
      body: `${child.child_name}: ${room.name} ← ${target.name}`,
      url: '/',
    }).catch(err => console.error('[move-request] push failed:', err.message)));
  }).catch(() => {});

  res.status(201).json({ ok: true, request_id: String(request._id), to: target.name });
}

module.exports = {
  board, updateLog, setClassroomDay, setMenu, settings, saveOptions, saveMenu,
  boardCandidates, extendOnBoard, releaseFromBoard, requestMove,
};
