/**
 * Every database read and write of סידור עבודה.
 *
 * The controller only translates HTTP; the rules that need no database live
 * in ratio.js / seed.js / rules.js. Keeping all writes here is what lets the
 * permission checks sit next to the writes they guard.
 */
const mongoose = require('mongoose');
const {
  ShiftWeek, ShiftEditRequest, Branch, Classroom, Child, Employee,
  EmployeeCommitment, Holiday, User,
} = require('../../models');
const notificationService = require('../notification.service');
const { branchManagerFilter } = require('../branch-recipients.service');
const { closureDateSet, todayIsrael } = require('../fixedSchedule');
const rotaPay = require('./rotaPay.service');
const { effectiveRatios, ratioWarnings } = require('./ratio');
const { buildSeedEntries } = require('./seed');
const constraints = require('./constraints.service');
const cross = require('./crossBranch.service');
const rateRequests = require('./rateRequests.service');
const { hasBranchRate, placementKey, crossOverlaps, arrangementCovers } = require('./crossRules');
const { blocksEntry, submissionWindow } = require('./constraintRules');
const { ShiftError, OFFICE, canView, canEdit, assertView, assertEdit } = require('./access');
const {
  schoolYearOf, weekDays, isSunday, padHHMM, findOverlaps, affectedEmployeeIds, suggestPrimary, needsPrimaryPrompt,
} = require('./rules');

async function loadWeekOr404(weekId) {
  if (!mongoose.isValidObjectId(weekId)) throw new ShiftError(404, 'סידור לא נמצא');
  const week = await ShiftWeek.findById(weekId);
  if (!week) throw new ShiftError(404, 'סידור לא נמצא');
  return week;
}

/** Holiday closures of the branch inside these dates, plus the week's own closed days. */
async function closedDatesFor(branchId, dates, week) {
  const holidays = await Holiday.find({
    branch_id: branchId, kind: 'closure',
    start_date: { $lte: new Date(`${dates[dates.length - 1]}T23:59:59+03:00`) },
    end_date: { $gte: new Date(`${dates[0]}T00:00:00+03:00`) },
  }).lean();
  const set = closureDateSet(holidays, branchId);
  for (const d of (week && week.closed_days) || []) set.add(d);
  return new Set(dates.filter(d => set.has(d)));
}

async function classroomsWithCounts(branchId, schoolYear) {
  const rooms = await Classroom.find({ branch_id: branchId, is_active: true, academic_year: schoolYear }).select('name category').sort({ name: 1 }).lean();
  const counts = await Child.aggregate([
    { $match: { classroom_id: { $in: rooms.map(r => r._id) }, is_active: true } },
    { $group: { _id: '$classroom_id', n: { $sum: 1 } } },
  ]);
  const byId = new Map(counts.map(c => [String(c._id), c.n]));
  return rooms.map(r => ({ _id: String(r._id), name: r.name, category: r.category || null, enrolled: byId.get(String(r._id)) || 0 }));
}

async function seedFor(branchId, dates, closedDates) {
  const [employees, commitments, rooms] = await Promise.all([
    Employee.find({ branch_id: branchId, is_active: true }).select('full_name primary_classroom_id').lean(),
    EmployeeCommitment.find({ branch_id: branchId }).lean(),
    Classroom.find({ branch_id: branchId, is_active: true, academic_year: schoolYearOf(dates[0]) }).select('_id').lean(),
  ]);
  return buildSeedEntries({
    dates, employees, commitments, closedDates,
    activeClassroomIds: new Set(rooms.map(r => String(r._id))),
  });
}

/** The seed for a new week, minus what an accepted constraint already rules out. */
async function seedRespectingConstraints(branchId, dates, closedDates) {
  const [seeded, locked] = await Promise.all([
    seedFor(branchId, dates, closedDates),
    constraints.acceptedFor({ branchId, dates }),
  ]);
  return seeded.filter(e => !locked.some(c => blocksEntry(c, e)));
}

async function getBoard({ user, branchId, weekStart }) {
  if (!mongoose.isValidObjectId(branchId)) throw new ShiftError(404, 'סניף לא נמצא');
  if (!isSunday(weekStart)) throw new ShiftError(400, 'שבוע מתחיל ביום ראשון');
  assertView(user, branchId);
  const branch = await Branch.findById(branchId).lean();
  if (!branch) throw new ShiftError(404, 'סניף לא נמצא');
  const dates = weekDays(weekStart);
  const week = await ShiftWeek.findOne({ branch_id: branchId, week_start: weekStart });
  const closed = await closedDatesFor(branchId, dates, week);
  const classrooms = await classroomsWithCounts(branchId, schoolYearOf(weekStart));
  const ratios = effectiveRatios(branch);
  const preview = week ? null : await seedRespectingConstraints(branchId, dates, closed);
  const entries = week ? week.entries.map(e => e.toObject()) : preview;

  const [employees, commitments, inactive, editRequests] = await Promise.all([
    Employee.find({ branch_id: branchId, is_active: true }).select('full_name primary_classroom_id extra_classroom_ids').sort({ full_name: 1 }).lean(),
    EmployeeCommitment.find({ branch_id: branchId }).lean(),
    Classroom.find({ branch_id: branchId, is_active: false, academic_year: schoolYearOf(weekStart) }).select('name academic_year').sort({ academic_year: -1, name: 1 }).lean(),
    week ? ShiftEditRequest.find({ shift_week_id: week._id, status: 'pending' }).sort({ created_at: -1 }).lean() : [],
  ]);
  const commitmentOf = new Map(commitments.map(c => [String(c.employee_id), c]));
  const pending_primary = employees
    .filter(e => needsPrimaryPrompt(e, commitmentOf.get(String(e._id))))
    .map(e => {
      const text = commitmentOf.get(String(e._id)).classroom;
      return { employee_id: String(e._id), full_name: e.full_name, commitment_text: text, ...suggestPrimary({ commitmentText: text, classrooms }) };
    });

  const weekConstraints = await constraints.forBoard({ branchId, dates, entries });

  const branchEmployeeIds = employees.map(e => String(e._id));
  const [foreignCandidates, away, crossPending, arrangements, allRateRequests] = await Promise.all([
    cross.foreignCandidates({ hostBranchId: branchId }),
    cross.otherBranchEntries({ weekStart, employeeIds: branchEmployeeIds, excludeBranchId: branchId }),
    cross.homePending({ branchId }),
    cross.arrangementsFor({ user, branchId }),
    rateRequests.listRateRequests({ user }),
  ]);

  return {
    week: week ? week.toObject() : null,
    constraints: weekConstraints,
    preview,
    dates,
    closed_dates: [...closed],
    classrooms,
    inactive_classrooms: inactive.map(r => ({ _id: String(r._id), name: r.name, academic_year: r.academic_year })),
    employees: employees.map(e => ({ _id: String(e._id), full_name: e.full_name, primary_classroom_id: e.primary_classroom_id ? String(e.primary_classroom_id) : null, extra_classroom_ids: (e.extra_classroom_ids || []).map(String) }))
      .concat(foreignCandidates.filter(c => c.has_rate).map(c => ({ _id: String(c._id), full_name: `${c.full_name} (${c.branch_name})`, primary_classroom_id: null, extra_classroom_ids: [], foreign: true }))),
    ratios,
    // What the branch itself set, blank where it follows the city default —
    // the settings form edits these, not the effective values above.
    ratio_overrides: Object.fromEntries(['infants', 'young', 'older'].map((k) => {
      const v = branch.staff_ratios && branch.staff_ratios[k];
      return [k, v == null ? '' : v];
    })),
    warnings: ratioWarnings({ entries, classrooms, dates, closedDates: closed, ratios }),
    pending_primary,
    edit_requests: editRequests,
    can_edit: canEdit(user, branchId),
    can_request: OFFICE.includes(user.role),
    branch_id: String(branch._id),
    branch_name: branch.name,
    foreign_candidates: foreignCandidates,
    away,
    cross_pending: crossPending,
    arrangements,
    rate_requests: allRateRequests.filter(r => String(r.home_branch_id) === String(branchId) || String(r.host_branch_id) === String(branchId) || ['system_admin', 'accountant'].includes(user.role)),
    has_unpublished_changes: week ? affectedEmployeeIds(week.published, week.entries).size > 0 || !week.published_at : false,
  };
}

async function createWeek({ user, branchId, weekStart }) {
  if (!isSunday(weekStart)) throw new ShiftError(400, 'שבוע מתחיל ביום ראשון');
  assertEdit(user, branchId);
  if (await ShiftWeek.exists({ branch_id: branchId, week_start: weekStart })) throw new ShiftError(409, 'הסידור לשבוע הזה כבר נפתח');
  const dates = weekDays(weekStart);
  const closed = await closedDatesFor(branchId, dates, null);
  const entries = await seedRespectingConstraints(branchId, dates, closed);
  try {
    return await ShiftWeek.create({ branch_id: branchId, week_start: weekStart, entries, created_by: user.id });
  } catch (err) {
    // Two opens racing past the check above: the unique index decides.
    if (err && err.code === 11000) throw new ShiftError(409, 'הסידור לשבוע הזה כבר נפתח');
    throw err;
  }
}

/** Clean what the client sent into Entry shape, refusing what cannot be stored. */
function normalizeEntries(raw, dates, closed) {
  const allowed = new Set(dates);
  return (Array.isArray(raw) ? raw : []).map((e) => {
    if (!mongoose.isValidObjectId(e.employee_id)) throw new ShiftError(400, 'עובדת לא תקינה בשיבוץ');
    if (!allowed.has(e.date)) throw new ShiftError(400, `תאריך ${e.date} לא בשבוע הזה`);
    if (closed.has(e.date)) throw new ShiftError(400, `${e.date} — יום שהגן סגור`);
    if (!['class', 'kitchen', 'floater', 'unassigned'].includes(e.area)) throw new ShiftError(400, 'שורה לא תקינה');
    if (e.area === 'class' && !mongoose.isValidObjectId(e.classroom_id)) throw new ShiftError(400, 'חסרה כיתה');
    return {
      ...(mongoose.isValidObjectId(e._id) ? { _id: e._id } : {}),
      employee_id: e.employee_id,
      employee_name: String(e.employee_name || ''),
      date: e.date,
      area: e.area,
      classroom_id: e.area === 'class' ? e.classroom_id : null,
      start_hhmm: padHHMM(e.start_hhmm),
      end_hhmm: padHHMM(e.end_hhmm),
      alternating: !!e.alternating,
      new_class: !!e.new_class,
    };
  });
}

/**
 * Validate a proposed week against the database, without writing anything:
 * overlaps, branch boundary (employees and classes must belong to the week's
 * branch), and the fields the server owns — the name is always the employee's
 * real one, and new_class is derived here, never taken from the client.
 * Returns the clean entries and the classes to record on each employee card.
 */
async function prepareEntries(week, raw) {
  const dates = weekDays(week.week_start);
  const closed = await closedDatesFor(week.branch_id, dates, week);
  const entries = normalizeEntries(raw, dates, closed);
  const overlaps = findOverlaps(entries);
  if (overlaps.length) {
    const first = overlaps[0];
    throw new ShiftError(400, `${first.employee_name || 'עובדת'} משובצת בשעות חופפות ב-${first.date}`, { overlaps });
  }
  const employees = await Employee.find({ _id: { $in: [...new Set(entries.map(e => String(e.employee_id)))] } })
    .select('full_name branch_id primary_classroom_id extra_classroom_ids branch_rates');
  const byId = new Map(employees.map(e => [String(e._id), e]));
  const roomIds = [...new Set(entries.filter(e => e.area === 'class').map(e => String(e.classroom_id)))];
  const rooms = roomIds.length ? await Classroom.find({ _id: { $in: roomIds }, branch_id: week.branch_id, academic_year: schoolYearOf(week.week_start) }).select('_id').lean() : [];
  const branchRooms = new Set(rooms.map(r => String(r._id)));
  // A placement already flagged in the stored week stays flagged until it is moved.
  const flagged = new Set(week.entries.filter(e => e.new_class).map(e => `${e.employee_id}|${e.classroom_id}`));
  const additions = new Map();
  for (const e of entries) {
    const emp = byId.get(String(e.employee_id));
    if (!emp) throw new ShiftError(400, 'עובדת לא נמצאה');
    const foreign = String(emp.branch_id) !== String(week.branch_id);
    if (foreign && !hasBranchRate(emp, week.branch_id)) {
      throw new ShiftError(400, `ל${emp.full_name} אין תעריף לסניף הזה — יש לשלוח בקשת תעריף`, { needs_rate: String(emp._id) });
    }
    e.cross_branch = foreign;
    e.cross_status = null;
    if (e.area === 'class' && !branchRooms.has(String(e.classroom_id))) throw new ShiftError(400, 'הכיתה לא שייכת לסניף');
    e.employee_name = emp.full_name;
    // 'HH:MM' strings compare in time order.
    if (e.start_hhmm && e.end_hhmm && e.start_hhmm >= e.end_hhmm) {
      throw new ShiftError(400, `${emp.full_name || 'עובדת'} — שעת הסיום לפני שעת ההתחלה ב-${e.date}`);
    }
    e.new_class = false;
    if (e.area !== 'class') continue;
    const known = [emp.primary_classroom_id, ...(emp.extra_classroom_ids || [])].filter(Boolean).map(String);
    if (!known.includes(String(e.classroom_id))) {
      const added = additions.get(String(emp._id)) || new Set();
      added.add(String(e.classroom_id));
      additions.set(String(emp._id), added);
      e.new_class = true;
    } else if (flagged.has(`${e.employee_id}|${e.classroom_id}`)) {
      e.new_class = true;
    }
  }
  // Cross-branch: approval carried over, or by a permanent arrangement; otherwise pending.
  const foreignIds = [...new Set(entries.filter(e => e.cross_branch).map(e => String(e.employee_id)))];
  const approvedBefore = new Set(week.entries.filter(e => e.cross_status === 'approved').map(e => placementKey(e)));
  const arrangements = foreignIds.length ? await cross.activeArrangements({ hostBranchId: week.branch_id, employeeIds: foreignIds }) : [];
  for (const e of entries) {
    if (!e.cross_branch) continue;
    e.cross_status = (approvedBefore.has(placementKey(e)) || arrangements.some(a => arrangementCovers(a, e))) ? 'approved' : 'pending';
  }
  // Nobody in two branches at once.
  const allIds = [...new Set(entries.map(e => String(e.employee_id)))];
  const elsewhere = await cross.otherBranchEntries({ weekStart: week.week_start, employeeIds: allIds, excludeBranchId: week.branch_id });
  const clash = crossOverlaps(entries, elsewhere);
  if (clash.length) {
    const c = clash[0];
    const where = elsewhere.find(o => o.branch_id === c.other_branch_id);
    throw new ShiftError(400, `${c.employee_name} משובצת באותן שעות בסניף ${where ? where.branch_name : 'אחר'} ב-${c.date}`);
  }
  // An accepted constraint is final: the employee cannot be put back on it.
  const locked = await constraints.acceptedFor({ branchId: week.branch_id, dates });
  for (const e of entries) {
    const hit = locked.find(c => blocksEntry(c, e));
    if (hit) throw new ShiftError(400, `${e.employee_name || 'עובדת'} — יש לה אילוץ מאושר ב-${e.date}`);
  }
  return { entries, additions };
}

/** The shared write behind a manager's save and an approved office request. */
async function applyEntries(week, raw) {
  const { entries, additions } = await prepareEntries(week, raw);
  const prevPendingKeys = new Set(week.entries.filter(e => e.cross_status === 'pending').map(e => placementKey(e)));
  for (const [empId, rooms] of additions) {
    await Employee.updateOne({ _id: empId }, { $addToSet: { extra_classroom_ids: { $each: [...rooms] } } });
  }
  week.entries = entries;
  await week.save();
  const newlyPending = week.entries.filter(e => e.cross_status === 'pending' && !prevPendingKeys.has(placementKey(e)));
  if (newlyPending.length) {
    const homes = await Employee.find({ _id: { $in: newlyPending.map(e => e.employee_id) } }).select('branch_id full_name').lean();
    for (const h of homes) {
      const ids = await cross.managersOf(h.branch_id);
      await Promise.all(ids.map(recipient_id => notificationService.notifyOnce({
        type: 'cross_placement_request', ref_collection: 'ShiftWeek', ref_id: week._id, recipient_id,
        title: `${h.full_name} שובצה בסניף אחר`, body: 'נדרש אישור שלך לשיבוץ', url: '/shifts',
      }).catch(err => console.error('[shifts] notify failed:', err.message))));
    }
  }
  return week;
}

async function saveEntries({ user, weekId, entries }) {
  const week = await loadWeekOr404(weekId);
  assertEdit(user, week.branch_id);
  return applyEntries(week, entries);
}

async function setClosedDay({ user, weekId, date, closed }) {
  const week = await loadWeekOr404(weekId);
  assertEdit(user, week.branch_id);
  if (!weekDays(week.week_start).includes(date)) throw new ShiftError(400, 'התאריך לא בשבוע הזה');
  const days = new Set(week.closed_days);
  if (closed) { days.add(date); week.entries = week.entries.filter(e => e.date !== date); } else days.delete(date);
  week.closed_days = [...days].sort();
  await week.save();
  return week;
}

async function userIdsOf(employeeIds) {
  if (!employeeIds.length) return [];
  const rows = await Employee.find({ _id: { $in: employeeIds }, user_id: { $ne: null } }).select('user_id').lean();
  return rows.map(r => r.user_id);
}

async function publishWeek({ user, weekId, now = new Date() }) {
  const week = await loadWeekOr404(weekId);
  assertEdit(user, week.branch_id);
  if (submissionWindow([week.week_start], now).ok) {
    throw new ShiftError(409, 'אי אפשר לסגור את הסידור לפני שהגשת האילוצים נסגרת (יום חמישי ב-18:00)');
  }
  if (week.entries.some(e => e.cross_status === 'pending')) {
    throw new ShiftError(409, 'יש שיבוצים מסניף אחר שממתינים לאישור מנהלת סניף הבית');
  }
  const autoAccepted = await constraints.resolveForPublish({ user, week, entries: week.entries.map(e => e.toObject()) });
  const first = !week.published_at;
  const affected = [...affectedEmployeeIds(first ? [] : week.published, week.entries)];
  week.published = week.entries.map(e => e.toObject());
  week.published_at = new Date();
  week.published_by = user.id;
  await week.save();
  try {
    const closed = await closedDatesFor(week.branch_id, weekDays(week.week_start), week);
    await rotaPay.applyRotaToFixedSchedules({ week: week.toObject(), closedDates: closed, today: todayIsrael() });
  } catch (err) { console.error('[shifts] rota → fixed schedule failed:', err.message); }

  const recipients = await userIdsOf(affected);
  const [, m, d] = week.week_start.split('-');
  const label = `${d}/${m}`;
  await Promise.all(recipients.map(recipient_id => notificationService.notifyOnce({
    type: first ? 'shift_published' : 'shift_changed',
    ref_collection: 'ShiftWeek', ref_id: week._id, recipient_id,
    title: first ? `הסידור לשבוע ${label} פורסם` : `הסידור שלך לשבוע ${label} עודכן`,
    body: first ? 'אפשר לראות את המשמרות שלך ושל כל הסניף' : 'יש שינוי במשמרות שלך — כדאי להציץ',
    url: `/my-shifts?week=${week.week_start}`,
  }).catch(err => console.error('[shifts] notify failed:', err.message))));
  return { week, notified: recipients.length, auto_accepted: autoAccepted };
}

async function setPrimaryClassroom({ user, employeeId, classroomId }) {
  if (!mongoose.isValidObjectId(employeeId)) throw new ShiftError(404, 'עובדת לא נמצאה');
  if (!mongoose.isValidObjectId(classroomId)) throw new ShiftError(404, 'כיתה לא נמצאה');
  const emp = await Employee.findById(employeeId);
  if (!emp) throw new ShiftError(404, 'עובדת לא נמצאה');
  assertEdit(user, emp.branch_id);
  const room = await Classroom.findOne({ _id: classroomId, branch_id: emp.branch_id, is_active: true });
  if (!room) throw new ShiftError(400, 'הכיתה לא שייכת לסניף');
  emp.primary_classroom_id = room._id;
  emp.extra_classroom_ids = (emp.extra_classroom_ids || []).filter(id => String(id) !== String(room._id));
  await emp.save();
  return emp;
}

async function closeClassroom({ user, classroomId }) {
  if (!mongoose.isValidObjectId(classroomId)) throw new ShiftError(404, 'כיתה לא נמצאה');
  const room = await Classroom.findById(classroomId);
  if (!room) throw new ShiftError(404, 'כיתה לא נמצאה');
  assertEdit(user, room.branch_id);
  const kids = await Child.countDocuments({ classroom_id: room._id, is_active: true });
  if (kids > 0) throw new ShiftError(409, `בכיתה ${kids} ילדים רשומים — קודם מעבירים אותם`);
  room.is_active = false;
  await room.save();
  return room;
}

async function reopenClassroom({ user, classroomId }) {
  if (!mongoose.isValidObjectId(classroomId)) throw new ShiftError(404, 'כיתה לא נמצאה');
  const room = await Classroom.findById(classroomId);
  if (!room) throw new ShiftError(404, 'כיתה לא נמצאה');
  assertEdit(user, room.branch_id);
  room.is_active = true;
  await room.save();
  return room;
}

async function setRatios({ user, branchId, ratios }) {
  if (!mongoose.isValidObjectId(branchId)) throw new ShiftError(404, 'סניף לא נמצא');
  if (!(canEdit(user, branchId) || user.role === 'system_admin')) throw new ShiftError(403, 'אין הרשאה');
  const clean = {};
  for (const key of ['infants', 'young', 'older']) {
    const v = Number(ratios && ratios[key]);
    clean[`staff_ratios.${key}`] = Number.isFinite(v) && v > 0 ? v : null;
  }
  await Branch.updateOne({ _id: branchId }, { $set: clean });
}

async function createEditRequest({ user, weekId, entries }) {
  if (!OFFICE.includes(user.role)) throw new ShiftError(403, 'רק המשרד מגיש בקשת שינוי');
  const week = await loadWeekOr404(weekId);
  const { entries: clean } = await prepareEntries(week, entries);
  // Only she approves, so only she is told; with no manager there is no one
  // to approve and the request would wait forever.
  const managers = await User.find({ ...branchManagerFilter(week.branch_id), role: 'branch_manager' }).select('_id').lean();
  if (!managers.length) throw new ShiftError(409, 'לסניף אין מנהלת — אין מי שיאשר את הבקשה');
  const changedIds = [...affectedEmployeeIds(week.entries.map(e => e.toObject()), clean)];
  const changedEmps = changedIds.length
    ? await Employee.find({ _id: { $in: changedIds } }).select('full_name').sort({ full_name: 1 }).lean() : [];
  const doc = await ShiftEditRequest.create({
    shift_week_id: week._id, branch_id: week.branch_id, entries: clean,
    week_version: week.updated_at,
    changed_names: changedEmps.map(e => e.full_name),
    requested_by: user.id, requested_by_name: user.full_name || '',
  });
  await Promise.all(managers.map(m => String(m._id)).map(recipient_id => notificationService.createEvent({
    type: 'shift_edit_request', ref_collection: 'ShiftEditRequest', ref_id: doc._id, recipient_id,
    title: 'בקשת שינוי בסידור העבודה', body: `${doc.requested_by_name || 'המשרד'} מבקש/ת לשנות את הסידור`,
    url: `/shifts?week=${week.week_start}`,
  }).catch(err => console.error('[shifts] notify failed:', err.message))));
  return doc;
}

async function decideEditRequest({ user, requestId, approve, reason }) {
  if (!mongoose.isValidObjectId(requestId)) throw new ShiftError(404, 'בקשה לא נמצאה');
  const doc = await ShiftEditRequest.findById(requestId);
  if (!doc) throw new ShiftError(404, 'בקשה לא נמצאה');
  assertEdit(user, doc.branch_id);
  if (doc.status !== 'pending') throw new ShiftError(409, 'הבקשה כבר טופלה');
  if (!approve && !String(reason || '').trim()) throw new ShiftError(400, 'יש לכתוב סיבה לדחייה');
  if (approve) {
    const week = await loadWeekOr404(doc.shift_week_id);
    // The request is a whole week; approving it over later edits would undo them.
    const current = week.updated_at ? new Date(week.updated_at).getTime() : null;
    const filed = doc.week_version ? new Date(doc.week_version).getTime() : null;
    if (current !== filed) throw new ShiftError(409, 'הסידור השתנה מאז שהבקשה נשלחה — יש לדחות ולבקש מחדש');
    await applyEntries(week, doc.entries);
  }
  doc.status = approve ? 'approved' : 'rejected';
  doc.decided_by = user.id;
  doc.decided_by_name = user.full_name || '';
  doc.decided_at = new Date();
  doc.reject_reason = approve ? '' : String(reason).trim();
  await doc.save();
  await notificationService.resolveEvents({ ref_collection: 'ShiftEditRequest', ref_id: doc._id });
  await notificationService.notifyOnce({
    type: 'shift_edit_decision', ref_collection: 'ShiftEditRequest', ref_id: doc._id, recipient_id: doc.requested_by,
    title: approve ? 'בקשת השינוי בסידור אושרה' : 'בקשת השינוי בסידור נדחתה',
    body: approve ? 'השינוי הוחל על הסידור' : doc.reject_reason,
    url: '/shifts',
  }).catch(err => console.error('[shifts] notify failed:', err.message));
  return doc;
}

async function myShifts({ employee, weekStart }) {
  if (!isSunday(weekStart)) throw new ShiftError(400, 'שבוע מתחיל ביום ראשון');
  const branchId = employee.branch_id;
  const [week, branch, rooms] = await Promise.all([
    ShiftWeek.findOne({ branch_id: branchId, week_start: weekStart }).lean(),
    Branch.findById(branchId).select('name').lean(),
    Classroom.find({ branch_id: branchId }).select('name').lean(),
  ]);
  const published = !!(week && week.published_at);
  return {
    week_start: weekStart,
    dates: weekDays(weekStart),
    branch_name: branch ? branch.name : '',
    published,
    entries: published ? week.published : [],
    classrooms: rooms.map(r => ({ _id: String(r._id), name: r.name })),
    me: String(employee._id),
  };
}

module.exports = {
  ShiftError, canView, canEdit, getBoard, createWeek, saveEntries, setClosedDay, publishWeek,
  setPrimaryClassroom, closeClassroom, reopenClassroom, setRatios,
  createEditRequest, decideEditRequest, myShifts,
};
