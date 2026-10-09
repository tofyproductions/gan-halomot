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
  EmployeeCommitment, EmployeeRequest, Holiday, SpecialDay, User,
} = require('../../models');
const notificationService = require('../notification.service');
const { branchManagerFilter } = require('../branch-recipients.service');
const { closureDateSet, todayIsrael } = require('../fixedSchedule');
const rotaPay = require('./rotaPay.service');
const { effectiveRatios, ratioWarnings, pmNeededCaps } = require('./ratio');
const { buildSeedEntries, placementFor, onMaternityLeave } = require('./seed');
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

/**
 * Days the gan does not run inside these dates: holiday closures, employer
 * shut days (SpecialDay — יום צוות, מסיבת סיום), plus the week's own closed days.
 */
async function closedDatesFor(branchId, dates, week) {
  const [holidays, specials] = await Promise.all([
    Holiday.find({
      branch_id: branchId, kind: 'closure',
      start_date: { $lte: new Date(`${dates[dates.length - 1]}T23:59:59+03:00`) },
      end_date: { $gte: new Date(`${dates[0]}T00:00:00+03:00`) },
    }).lean(),
    SpecialDay.find({
      date: { $in: dates },
      $or: [{ branch_id: branchId }, { branch_id: null }],
    }).select('date').lean(),
  ]);
  const set = closureDateSet(holidays, branchId);
  for (const s of specials) set.add(s.date);
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

/**
 * Active children still sitting in the branch's rooms of ANOTHER year (or
 * in a closed room): registered, active — and invisible to the tekken, so
 * "25 רשומים" showed as 10 on the board and the gap had no face. Counted so
 * the board can say it out loud instead of silently under-counting.
 */
async function staleEnrolledCount(branchId, schoolYear) {
  const other = await Classroom.find({
    branch_id: branchId,
    $or: [{ is_active: false }, { academic_year: { $ne: schoolYear } }],
  }).select('_id').lean();
  if (!other.length) return 0;
  return Child.countDocuments({ classroom_id: { $in: other.map(r => r._id) }, is_active: true });
}

async function seedFor(branchId, dates, closedDates) {
  const employees = await Employee.find({ branch_id: branchId, is_active: true }).select('full_name primary_classroom_id shift_area shift_day_classrooms on_maternity_leave maternity_leave_from maternity_leave_to').lean();
  // Commitments by employee, not by the commitment's own branch_id copy — a
  // stale branch on the commitment row must not drop her from the seed.
  const [commitments, rooms] = await Promise.all([
    EmployeeCommitment.find({ employee_id: { $in: employees.map(e => e._id) } }).lean(),
    Classroom.find({ branch_id: branchId, is_active: true, academic_year: schoolYearOf(dates[0]) }).select('_id').lean(),
  ]);
  return buildSeedEntries({
    dates, employees, commitments, closedDates,
    activeClassroomIds: new Set(rooms.map(r => String(r._id))),
  });
}

/**
 * The seed for a new week, minus what an accepted constraint already rules out
 * and minus hours she is already placed at in another branch.
 */
async function seedRespectingConstraints(branchId, dates, closedDates) {
  const seeded = await seedFor(branchId, dates, closedDates);
  const ids = [...new Set(seeded.map(e => String(e.employee_id)))];
  const [locked, elsewhere] = await Promise.all([
    constraints.acceptedFor({ employeeIds: ids, dates }),
    cross.otherBranchEntries({ weekStart: dates[0], employeeIds: ids, excludeBranchId: branchId }),
  ]);
  return seeded.filter(e => !locked.some(c => blocksEntry(c, e)) && !crossOverlaps([e], elsewhere).length);
}

/** Her contracted hours per weekday (0-5) — the drag-and-drop default for a new shift. Days off and blank days are left out. */
function commitmentHours(commitment) {
  const out = {};
  for (const d of (commitment && commitment.days) || []) {
    if (d.is_off || !d.start_hhmm || !d.end_hhmm) continue;
    out[d.day] = { start_hhmm: padHHMM(d.start_hhmm), end_hhmm: padHHMM(d.end_hhmm) };
  }
  return out;
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
  const staleEnrolled = await staleEnrolledCount(branchId, schoolYearOf(weekStart));
  const ratios = effectiveRatios(branch);
  const preview = week ? null : await seedRespectingConstraints(branchId, dates, closed);
  const entries = week ? week.entries.map(e => e.toObject()) : preview;

  /**
   * The board's people: the active staff, plus an INACTIVE employee who is
   * on maternity leave. Her card was switched off so payroll stops counting
   * her — but the rota is a different question: she may come back one day a
   * week, and the manager must be able to place her. Pay is punch-driven, so
   * a placement alone never reaches her payslip. The weekly seed (seedFor)
   * still reads active-only — she is offered, never auto-placed.
   */
  const employees = await Employee.find({
    branch_id: branchId,
    $or: [{ is_active: true }, { on_maternity_leave: true }],
  }).select('full_name primary_classroom_id extra_classroom_ids shift_area shift_day_classrooms on_maternity_leave maternity_leave_from maternity_leave_to is_active').sort({ full_name: 1 }).lean();
  const [commitments, inactive, editRequests] = await Promise.all([
    // By employee, like seedFor — see the comment there.
    EmployeeCommitment.find({ employee_id: { $in: employees.map(e => e._id) } }).lean(),
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

  /**
   * Sick days overlapping the week — whoever filed them and wherever they
   * stand (pending or approved): a manager building Sunday's rota needs to
   * know TODAY that a sick note covers it, not after accounting signs. A
   * rejected request is nobody's sick day. `to_date` null means one day.
   */
  const sickRequests = await EmployeeRequest.find({
    employee_id: { $in: employees.map(e => e._id) },
    type: 'sick',
    status: { $in: ['pending', 'pending_manager', 'pending_accountant', 'approved'] },
    from_date: { $lte: dates[dates.length - 1] },
    $or: [{ to_date: null }, { to_date: '' }, { to_date: { $gte: dates[0] } }],
  }).select('employee_id from_date to_date status').lean();

  const branchEmployeeIds = employees.map(e => String(e._id));
  const [foreignCandidates, away, crossPending, arrangements, allRateRequests] = await Promise.all([
    cross.foreignCandidates({ hostBranchId: branchId }),
    cross.otherBranchEntries({ weekStart, employeeIds: branchEmployeeIds, excludeBranchId: branchId }),
    cross.homePending({ branchId, user }),
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
    stale_enrolled: staleEnrolled,
    inactive_classrooms: inactive.map(r => ({ _id: String(r._id), name: r.name, academic_year: r.academic_year })),
    employees: employees.map(e => ({
      _id: String(e._id), full_name: e.full_name,
      primary_classroom_id: e.primary_classroom_id ? String(e.primary_classroom_id) : null,
      extra_classroom_ids: (e.extra_classroom_ids || []).map(String),
      shift_area: e.shift_area || null,
      shift_day_classrooms: (e.shift_day_classrooms || []).map(m => ({ day: m.day, classroom_id: String(m.classroom_id) })),
      has_commitment: commitmentOf.has(String(e._id)),
      // The weekdays her commitment marks is_off — the suggestions may still
      // offer her for a gap, but must SAY it is her day off.
      off_days: ((commitmentOf.get(String(e._id)) || {}).days || []).filter(d => d.is_off).map(d => d.day),
      commitment_text: (commitmentOf.get(String(e._id)) || {}).classroom || '',
      commitment: commitmentHours(commitmentOf.get(String(e._id))),
      // On leave she is not seeded, but she stays HERE: a gradual return is
      // placed by hand, so the board must still offer her.
      on_maternity_leave: !!e.on_maternity_leave,
      maternity_leave_from: e.maternity_leave_from || null,
      maternity_leave_to: e.maternity_leave_to || null,
      // An inactive card on the board (maternity only) — the sidebar says so.
      inactive: e.is_active === false,
    }))
      .concat(foreignCandidates.filter(c => c.has_rate).map(c => ({ _id: String(c._id), full_name: `${c.full_name} (${c.branch_name})`, primary_classroom_id: null, extra_classroom_ids: [], foreign: true, commitment: {} }))),
    ratios,
    // Where the office said a smaller afternoon crew is the arrangement —
    // the צהריים pill caps its needed figure by these (see ratio.js).
    pm_caps: pmNeededCaps(branch.name),
    sick_days: sickRequests.map(r => ({
      employee_id: String(r.employee_id),
      from_date: r.from_date,
      to_date: r.to_date || r.from_date,
      status: r.status,
    })),
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
    // The admin edits directly now (can_edit); only the accountant goes through
    // an edit request.
    can_request: user.role === 'accountant',
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
      sick_ok: !!e.sick_ok,
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
  const homeHasManager = new Map();
  for (const e of entries) {
    const emp = byId.get(String(e.employee_id));
    if (!emp) throw new ShiftError(400, 'עובדת לא נמצאה');
    const foreign = String(emp.branch_id) !== String(week.branch_id);
    if (foreign && !hasBranchRate(emp, week.branch_id)) {
      throw new ShiftError(400, `ל${emp.full_name} אין תעריף לסניף הזה — יש לשלוח בקשת תעריף`, { needs_rate: String(emp._id) });
    }
    if (foreign) {
      // Her home manager approves the placement; with none, it would wait forever.
      const key = String(emp.branch_id);
      if (!homeHasManager.has(key)) homeHasManager.set(key, (await cross.managersOf(emp.branch_id)).length > 0);
      if (!homeHasManager.get(key)) throw new ShiftError(409, `לסניף הבית של ${emp.full_name} אין מנהלת שתאשר את השיבוץ`);
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
  // Hers wherever it was filed — a day off accepted at home binds the host too.
  const locked = await constraints.acceptedFor({ employeeIds: allIds, dates });
  for (const e of entries) {
    const hit = locked.find(c => blocksEntry(c, e));
    if (hit) throw new ShiftError(400, `${e.employee_name || 'עובדת'} — יש לה אילוץ מאושר ב-${e.date}`);
  }
  return { entries, additions };
}

/** The shared write behind a manager's save and an approved office request. */
async function applyEntries(week, raw, user) {
  const { entries, additions } = await prepareEntries(week, raw);
  /**
   * One person, two hats: when the manager SAVING the week also manages the
   * employee's home branch (משה דיין and קפלן share a manager), the home
   * approval is already in the save — asking her to approve her own request
   * was a notification with one possible answer. Everyone else still waits
   * for the real home manager.
   */
  const pendingCross = entries.filter(e => e.cross_status === 'pending');
  if (user && pendingCross.length) {
    const homes = await Employee.find({ _id: { $in: pendingCross.map(e => e.employee_id) } }).select('branch_id').lean();
    const homeOf = new Map(homes.map(h => [String(h._id), String(h.branch_id)]));
    for (const e of pendingCross) {
      const home = homeOf.get(String(e.employee_id));
      if (home && canEdit(user, home)) e.cross_status = 'approved';
    }
  }
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
  return applyEntries(week, entries, user);
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
  // Nobody published into two branches at once, however the overlap got in.
  const weekEntries = week.entries.map(e => e.toObject());
  const elsewhere = await cross.otherBranchEntries({ weekStart: week.week_start, employeeIds: [...new Set(weekEntries.map(e => String(e.employee_id)))], excludeBranchId: week.branch_id });
  const clash = crossOverlaps(weekEntries, elsewhere);
  if (clash.length) {
    const c = clash[0];
    const where = elsewhere.find(o => o.branch_id === c.other_branch_id);
    throw new ShiftError(409, `${c.employee_name} משובצת באותן שעות בסניף ${where ? where.branch_name : 'אחר'} ב-${c.date} — יש לתקן לפני הסגירה`);
  }
  if (week.entries.some(e => e.cross_status === 'pending')) {
    throw new ShiftError(409, 'יש שיבוצים מסניף אחר שממתינים לאישור מנהלת סניף הבית');
  }
  const autoAccepted = await constraints.resolveForPublish({ user, week, entries: week.entries.map(e => e.toObject()) });
  const first = !week.published_at;
  const affected = [...affectedEmployeeIds(first ? [] : week.published, week.entries)];
  const previousPublished = (week.published || []).map(e => e.toObject());
  week.published = week.entries.map(e => e.toObject());
  week.published_at = new Date();
  week.published_by = user.id;
  await week.save();
  try {
    const closed = await closedDatesFor(week.branch_id, weekDays(week.week_start), week);
    await rotaPay.applyRotaToFixedSchedules({ week: week.toObject(), closedDates: closed, today: todayIsrael(), previousPublished });
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

/**
 * Where her card places her on the rota, set once by the manager:
 *   area 'kitchen' / 'floater' — the cook / floater row, every day;
 *   area 'class' — her primary class, optionally a second one with a weekday
 *   map (`dayClassrooms` { weekday: classroomId }, only her two classes);
 *   area 'none' — not on the rota at all (paid some other way, no commitment).
 * Then the open weeks from this one on follow the new card: her "ללא כיתה"
 * shifts and the ones still where the OLD card put them move; a shift the
 * manager placed by hand stays. 'none' takes her off those weeks.
 */
async function setShiftPlacement({ user, employeeId, area = 'class', classroomId, secondClassroomId, dayClassrooms }) {
  if (!mongoose.isValidObjectId(employeeId)) throw new ShiftError(404, 'עובדת לא נמצאה');
  if (!['class', 'kitchen', 'floater', 'none'].includes(area)) throw new ShiftError(400, 'שיבוץ לא מוכר');
  const emp = await Employee.findById(employeeId);
  if (!emp) throw new ShiftError(404, 'עובדת לא נמצאה');
  assertEdit(user, emp.branch_id);
  const before = cardOf(emp);
  if (area === 'class') {
    const activeRoom = async (id) => {
      if (!mongoose.isValidObjectId(id)) throw new ShiftError(404, 'כיתה לא נמצאה');
      const room = await Classroom.findOne({ _id: id, branch_id: emp.branch_id, is_active: true });
      if (!room) throw new ShiftError(400, 'הכיתה לא שייכת לסניף');
      return room;
    };
    const room = await activeRoom(classroomId);
    const second = secondClassroomId ? await activeRoom(secondClassroomId) : null;
    if (second && String(second._id) === String(room._id)) throw new ShiftError(400, 'הכיתה השנייה זהה לראשית');
    const allowed = new Set([String(room._id), second && String(second._id)].filter(Boolean));
    const map = [];
    if (second) {
      for (const [day, id] of Object.entries(dayClassrooms || {})) {
        const d = Number(day);
        if (!Number.isInteger(d) || d < 0 || d > 5) throw new ShiftError(400, 'יום לא תקין');
        if (!id) continue;
        if (!allowed.has(String(id))) throw new ShiftError(400, 'בחירה לפי יום רק מבין שתי הכיתות');
        map.push({ day: d, classroom_id: id });
      }
    }
    emp.primary_classroom_id = room._id;
    const extra = (emp.extra_classroom_ids || []).filter(id => String(id) !== String(room._id));
    if (second && !extra.some(id => String(id) === String(second._id))) extra.push(second._id);
    emp.extra_classroom_ids = extra;
    emp.shift_area = null;
    emp.shift_day_classrooms = map;
  } else {
    emp.shift_area = area;
    emp.shift_day_classrooms = [];
  }
  await emp.save();
  if (area === 'none') {
    const removed = await removeFromOpenWeeks(emp);
    return { employee: emp, placed: 0, removed };
  }
  const placed = await placeByCards({ branchId: emp.branch_id, employeeIds: [String(emp._id)], previous: new Map([[String(emp._id), before]]) });
  return { employee: emp, placed, removed: 0 };
}

/** The placement fields of a card, detached — "where the old card put her". */
function cardOf(emp) {
  return {
    primary_classroom_id: emp.primary_classroom_id ? String(emp.primary_classroom_id) : null,
    shift_area: emp.shift_area || null,
    shift_day_classrooms: (emp.shift_day_classrooms || []).map(m => ({ day: m.day, classroom_id: String(m.classroom_id) })),
  };
}

async function removeFromOpenWeeks(emp) {
  const weeks = await ShiftWeek.find({ branch_id: emp.branch_id, week_start: { $gte: sundayOfYmd(todayIsrael()) }, 'entries.employee_id': emp._id });
  let removed = 0;
  for (const week of weeks) {
    const keep = week.entries.filter(e => String(e.employee_id) !== String(emp._id));
    removed += week.entries.length - keep.length;
    week.entries = keep;
    await week.save();
  }
  return removed;
}

/**
 * חופשת לידה נרשמה (או התאריכים שלה זזו): the open weeks stop expecting her.
 *
 * Marking the leave on her card is the "לא תעבוד בימים האלה" act — so the
 * rota answers it. Only HER entries, only on days inside the leave, only
 * from today on (yesterday happened), and only in `entries`, the editing
 * copy. She stays on the board's employee list and can be dragged back in
 * by hand — the seed skips the same dates (see seed.onMaternityLeave), so
 * she will not creep back on her own.
 */
async function removeMaternityPlacements(emp) {
  if (!emp.on_maternity_leave || !emp.branch_id) return 0;
  const today = todayIsrael();
  const weeks = await ShiftWeek.find({
    branch_id: emp.branch_id, week_start: { $gte: sundayOfYmd(today) }, 'entries.employee_id': emp._id,
  });
  let removed = 0;
  for (const week of weeks) {
    const keep = week.entries.filter(e => !(
      String(e.employee_id) === String(emp._id) && e.date >= today && onMaternityLeave(emp, e.date)
    ));
    if (keep.length === week.entries.length) continue;
    removed += week.entries.length - keep.length;
    week.entries = keep;
    await week.save();
  }
  return removed;
}

/**
 * Entries of open weeks (this week on, or one given week) moved to where the
 * employees' cards put them. Which entries may move:
 *   - "ללא כיתה" ones, always;
 *   - with `previous` (a card was just changed): those still exactly where
 *     the previous card put them — anything else the manager placed by hand;
 *   - without it (the board's button): those in one of her own card classes
 *     on a day the card gives the other one.
 * Returns how many moved.
 */
async function placeByCards({ branchId, employeeIds = null, weekId = null, previous = null }) {
  const filter = weekId ? { _id: weekId } : { branch_id: branchId, week_start: { $gte: sundayOfYmd(todayIsrael()) } };
  const weeks = await ShiftWeek.find(filter);
  if (!weeks.length) return 0;
  const ids = employeeIds || [...new Set(weeks.flatMap(w => w.entries.filter(e => !e.cross_branch).map(e => String(e.employee_id))))];
  if (!ids.length) return 0;
  const [emps, commitments] = await Promise.all([
    Employee.find({ _id: { $in: ids } }).select('primary_classroom_id shift_area shift_day_classrooms').lean(),
    EmployeeCommitment.find({ employee_id: { $in: ids } }).select('employee_id classroom').lean(),
  ]);
  const empOf = new Map(emps.map(e => [String(e._id), e]));
  const textOf = new Map(commitments.map(c => [String(c.employee_id), c.classroom]));
  const cardClasses = (emp) => new Set([emp.primary_classroom_id, ...(emp.shift_day_classrooms || []).map(m => m.classroom_id)].filter(Boolean).map(String));
  let placed = 0;
  for (const week of weeks) {
    const rooms = await Classroom.find({ branch_id: week.branch_id, is_active: true, academic_year: schoolYearOf(week.week_start) }).select('_id').lean();
    const active = new Set(rooms.map(r => String(r._id)));
    let changed = false;
    for (const e of week.entries) {
      if (e.cross_branch) continue;
      const id = String(e.employee_id);
      const emp = empOf.get(id);
      if (!emp || emp.shift_area === 'none') continue;
      const weekday = new Date(`${e.date}T12:00:00Z`).getUTCDay();
      const text = textOf.get(id);
      const p = placementFor(emp, weekday, text, active);
      if (p.area === 'unassigned') continue;
      const cls = e.classroom_id ? String(e.classroom_id) : null;
      if (e.area === p.area && cls === p.classroom_id) continue;
      let movable = e.area === 'unassigned';
      if (!movable && previous && previous.has(id)) {
        const old = placementFor(previous.get(id), weekday, text, active);
        movable = e.area === old.area && cls === old.classroom_id;
      } else if (!movable && !previous) {
        const mine = cardClasses(emp);
        movable = e.area === 'class' && p.area === 'class' && mine.has(cls);
      }
      if (!movable) continue;
      e.area = p.area;
      e.classroom_id = p.classroom_id;
      e.new_class = false;
      changed = true;
      placed += 1;
    }
    if (changed) await week.save();
  }
  return placed;
}

/**
 * Employees with a commitment but not a single shift in an open week — her
 * commitment (or her card) came after the week was opened — get the week's
 * seed for her, like a fresh week would. `employeeIds` narrows who; without
 * it every such employee of the branch. Returns how many shifts were added.
 */
async function seedMissing({ branchId, weekId = null, employeeIds = null }) {
  const filter = weekId ? { _id: weekId } : { branch_id: branchId, week_start: { $gte: sundayOfYmd(todayIsrael()) } };
  const weeks = await ShiftWeek.find(filter);
  let added = 0;
  for (const week of weeks) {
    const present = new Set(week.entries.map(e => String(e.employee_id)));
    const dates = weekDays(week.week_start);
    const closed = await closedDatesFor(week.branch_id, dates, week);
    const seeded = (await seedRespectingConstraints(week.branch_id, dates, closed))
      .filter(e => !present.has(String(e.employee_id)) && (!employeeIds || employeeIds.includes(String(e.employee_id))));
    if (!seeded.length) continue;
    week.entries.push(...seeded);
    await week.save();
    added += seeded.length;
  }
  return added;
}

/** The board's "שיבוץ לפי הכרטיסים" — one week, every employee: missing ones added, then placed. */
async function autoPlaceWeek({ user, weekId }) {
  if (!mongoose.isValidObjectId(weekId)) throw new ShiftError(404, 'סידור לא נמצא');
  const week = await ShiftWeek.findById(weekId).select('branch_id').lean();
  if (!week) throw new ShiftError(404, 'סידור לא נמצא');
  assertEdit(user, week.branch_id);
  const added = await seedMissing({ branchId: week.branch_id, weekId });
  const placed = await placeByCards({ branchId: week.branch_id, weekId });
  // Nothing moved can mean "all set" or "cards are missing" — let the client say which.
  const after = await ShiftWeek.findById(weekId).select('entries.area').lean();
  const unplaced = (after.entries || []).filter(e => e.area === 'unassigned').length;
  return { placed: placed + added, added, unplaced };
}

function sundayOfYmd(ymd) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
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
    await applyEntries(week, doc.entries, user);
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
  // Her own shifts in other branches' published rotas — shown to her, read-only.
  const awayWeeks = await ShiftWeek.find({ week_start: weekStart, branch_id: { $ne: branchId }, published_at: { $ne: null }, 'published.employee_id': employee._id }).lean();
  /**
   * The read receipt: opening this screen IS seeing the rota, so the weeks
   * shown here record her first look — the home week and every host week
   * alike. Guarded by the $ne so only the first view writes; a failure here
   * must never break her own screen.
   */
  const markViewed = (w) => ShiftWeek.updateOne(
    { _id: w._id, 'views.employee_id': { $ne: employee._id } },
    { $push: { views: { employee_id: employee._id, at: new Date() } } },
  ).catch(err => console.error('[shifts] view mark failed:', err.message));
  if (published) markViewed(week);
  for (const w of awayWeeks) markViewed(w);
  const awayNames = new Map((await Branch.find({ _id: { $in: awayWeeks.map(w => w.branch_id) } }).select('name').lean()).map(b => [String(b._id), b.name]));
  const away = awayWeeks.flatMap(w => (w.published || []).filter(e => String(e.employee_id) === String(employee._id))
    .map(e => ({ ...e, branch_id: String(w.branch_id), branch_name: awayNames.get(String(w.branch_id)) || '' })));
  // The room's NAME, not its id: her own screen says "תינוקייה בהרצליה",
  // and the host branch's room list is nowhere else in this payload.
  const awayRoomIds = [...new Set(away.filter(e => e.classroom_id).map(e => String(e.classroom_id)))];
  if (awayRoomIds.length) {
    const awayRooms = new Map((await Classroom.find({ _id: { $in: awayRoomIds } }).select('name').lean()).map(r => [String(r._id), r.name]));
    for (const e of away) e.classroom_name = e.classroom_id ? (awayRooms.get(String(e.classroom_id)) || '') : '';
  }
  return {
    week_start: weekStart,
    dates: weekDays(weekStart),
    branch_name: branch ? branch.name : '',
    published,
    entries: published ? week.published : [],
    away,
    classrooms: rooms.map(r => ({ _id: String(r._id), name: r.name })),
    me: String(employee._id),
  };
}

/**
 * The nudge for whoever has not opened it: everyone standing in the
 * PUBLISHED rota with no read receipt gets a push saying it is out. Sent on
 * demand by the manager, repeatable — a reminder ignored on Thursday may
 * still be needed on Saturday night.
 */
async function remindUnviewed({ user, weekId }) {
  const week = await loadWeekOr404(weekId);
  assertEdit(user, week.branch_id);
  if (!week.published_at) throw new ShiftError(409, 'הסידור עוד לא פורסם');
  const inRota = [...new Set((week.published || []).map(e => String(e.employee_id)))];
  const viewed = new Set((week.views || []).map(v => String(v.employee_id)));
  const target = inRota.filter(id => !viewed.has(id));
  const recipients = await userIdsOf(target);
  const [, m, d] = week.week_start.split('-');
  const label = `${d}/${m}`;
  await Promise.all(recipients.map(recipient_id => notificationService.notifyOnce({
    type: 'shift_published_reminder', ref_collection: 'ShiftWeek', ref_id: week._id, recipient_id,
    title: `תזכורת: סידור העבודה לשבוע ${label} פורסם`,
    body: 'עוד לא צפית במשמרות שלך — כדאי להציץ',
    url: `/my-shifts?week=${week.week_start}`,
  }).catch(err => console.error('[shifts] remind failed:', err.message))));
  // An employee with no linked user cannot be pushed — the manager should
  // hear that rather than assume the phone buzzed.
  return { reminded: recipients.length, no_user: target.length - recipients.length };
}

module.exports = {
  ShiftError, canView, canEdit, getBoard, createWeek, saveEntries, setClosedDay, publishWeek, remindUnviewed,
  setShiftPlacement, setPrimaryClassroom: (args) => setShiftPlacement({ ...args, area: 'class' }),
  placeByCards, autoPlaceWeek, removeFromOpenWeeks, removeMaternityPlacements, seedMissing, closeClassroom, reopenClassroom, setRatios,
  createEditRequest, decideEditRequest, myShifts,
};
