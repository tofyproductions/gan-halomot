/**
 * אילוצים — every database read and write.
 *
 * The employee side and the manager side meet here, and so do the two privacy
 * rules that matter: a volunteer list is a manager's (the requester gets a
 * count, a volunteer gets only her own tick), and an attachment is the
 * employee's and her managers' only.
 */
const mongoose = require('mongoose');
const { ShiftConstraint, Employee, EmployeeRequest, ShiftWeek, User } = require('../../models');
const notificationService = require('../notification.service');
const { branchManagerFilter } = require('../branch-recipients.service');
const storage = require('../storage.service');
const { weekStart } = require('../parentVisibility');
const { ShiftError, canView, assertEdit } = require('./access');
const { weekDays } = require('./rules');
const { otherBranchEntries } = require('./crossBranch.service');
const { TYPES, FINAL, ACTIONABLE, addDays, ilNow, submissionWindow, isFarFuture, respected, blocksEntry } = require('./constraintRules');

const MAX_FILES = 3;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = ['application/pdf', 'image/jpeg', 'image/png'];
const HHMM = /^\d{2}:\d{2}$/;
const label = (ymd) => ymd.split('-').reverse().slice(0, 2).join('/');

async function loadOr404(id) {
  if (!mongoose.isValidObjectId(id)) throw new ShiftError(404, 'אילוץ לא נמצא');
  const c = await ShiftConstraint.findById(id);
  if (!c) throw new ShiftError(404, 'אילוץ לא נמצא');
  return c;
}

async function notifyEmployee(employeeId, payload) {
  const emp = await Employee.findById(employeeId).select('user_id').lean();
  if (!emp || !emp.user_id) return 0;
  await notificationService.notifyOnce({ ...payload, recipient_id: emp.user_id })
    .catch(err => console.error('[constraints] notify failed:', err.message));
  return 1;
}

async function managersOf(branchId) {
  const users = await User.find({ ...branchManagerFilter(branchId), role: 'branch_manager' }).select('_id').lean();
  return users.map(u => u._id);
}

async function storeFiles(files) {
  if ((files || []).length > MAX_FILES) throw new ShiftError(400, `אפשר לצרף עד ${MAX_FILES} קבצים`);
  const out = [];
  for (const f of files || []) {
    if (!ALLOWED_MIME.includes(f.mimetype)) throw new ShiftError(400, 'אפשר לצרף רק PDF או תמונה (JPG/PNG)');
    if (f.size > MAX_FILE_BYTES) throw new ShiftError(400, 'קובץ גדול מ-10MB');
    const doc = { name: f.originalname || 'file', mimetype: f.mimetype, size: f.size };
    if (storage.isConfigured()) {
      const ext = f.mimetype === 'application/pdf' ? 'pdf' : (f.mimetype === 'image/png' ? 'png' : 'jpg');
      doc.storage_key = storage.makeKey('shift-constraints', ext);
      await storage.putObject({ key: doc.storage_key, body: f.buffer, contentType: f.mimetype });
    } else {
      doc.file_data = f.buffer.toString('base64');
    }
    out.push(doc);
  }
  return out;
}

/** Manager-facing: volunteers stay, file bytes never travel. */
function withoutFileBytes(c) {
  const o = c.toObject ? c.toObject() : { ...c };
  o.files = (o.files || []).map(f => ({ name: f.name, mimetype: f.mimetype, size: f.size }));
  return o;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

async function createConstraint({ employee, body, files, now = new Date() }) {
  const b = body || {};
  if (!employee.branch_id) throw new ShiftError(400, 'לכרטיס העובדת לא מוגדר סניף');
  if (!TYPES.includes(b.type)) throw new ShiftError(400, 'סוג אילוץ לא תקין');
  const details = String(b.details || '').trim().slice(0, 1000);
  const doc = {
    employee_id: employee._id, employee_name: employee.full_name, branch_id: employee.branch_id,
    type: b.type, date: String(b.date || ''), details, status: 'open',
  };
  if (!YMD.test(doc.date)) throw new ShiftError(400, 'תאריך לא תקין');
  const dates = [doc.date];
  if (['day_off', 'partial', 'sick_expected', 'other'].includes(b.type) && !details) throw new ShiftError(400, 'יש לכתוב סיבה או פירוט');
  if (b.type === 'partial') {
    if (!HHMM.test(b.from_hhmm || '') || !HHMM.test(b.to_hhmm || '') || b.from_hhmm >= b.to_hhmm) throw new ShiftError(400, 'שעת הסיום חייבת להיות אחרי שעת ההתחלה');
    doc.from_hhmm = b.from_hhmm; doc.to_hhmm = b.to_hhmm;
  }
  if (b.type === 'move_day' || (b.type === 'swap' && b.swap_mode === 'mutual')) {
    if (!b.target_date) throw new ShiftError(400, 'חסר היום שבו תעבדי במקום');
    if (!YMD.test(String(b.target_date))) throw new ShiftError(400, 'תאריך לא תקין');
    doc.target_date = String(b.target_date);
    if (weekStart(doc.target_date) !== weekStart(doc.date)) throw new ShiftError(400, 'שני הימים צריכים להיות באותו שבוע');
    dates.push(doc.target_date);
  }
  if (b.type === 'swap') {
    if (!['handover', 'mutual'].includes(b.swap_mode)) throw new ShiftError(400, 'יש לבחור סוג החלפה');
    doc.swap_mode = b.swap_mode;
    const broadcast = b.broadcast === true || b.broadcast === 'true';
    if (broadcast) {
      doc.broadcast = true; doc.status = 'pending_broadcast';
    } else {
      if (!mongoose.isValidObjectId(b.colleague_id)) throw new ShiftError(400, 'יש לבחור עובדת להחלפה');
      const colleague = await Employee.findOne({ _id: b.colleague_id, branch_id: employee.branch_id, is_active: true }).lean();
      if (!colleague || String(colleague._id) === String(employee._id)) throw new ShiftError(400, 'העובדת לא נמצאה בסניף שלך');
      doc.colleague_id = colleague._id; doc.status = 'pending_colleague';
    }
  }
  const win = submissionWindow(dates, now);
  if (!win.ok) throw new ShiftError(400, win.error);
  doc.week_start = weekStart(doc.date);
  const duplicate = await ShiftConstraint.exists({ employee_id: employee._id, type: doc.type, date: doc.date, status: { $nin: [...FINAL] } });
  if (duplicate) throw new ShiftError(409, 'כבר הגשת אילוץ כזה לתאריך הזה');
  doc.files = await storeFiles(files);
  const c = await ShiftConstraint.create(doc);
  if (c.status === 'pending_colleague') {
    await notifyEmployee(c.colleague_id, {
      type: 'swap_request', ref_collection: 'ShiftConstraint', ref_id: c._id,
      title: `${c.employee_name} מבקשת להחליף איתך`, body: `ב-${label(c.date)} — אפשר לאשר או לסרב`,
      url: '/my-shifts?tab=constraints',
    });
  }
  return publicView(c, employee._id);
}

/** What the employee may see: her own, requests addressed to her, open offers in her branch. */
function publicView(c, viewerId) {
  const o = c.toObject ? c.toObject() : { ...c };
  const mine = String(o.employee_id) === String(viewerId);
  const volunteerCount = (o.volunteers || []).length;
  const iVolunteered = (o.volunteers || []).some(v => String(v) === String(viewerId));
  delete o.volunteers;
  o.files = (o.files || []).map(f => ({ name: f.name, mimetype: f.mimetype, size: f.size }));
  if (mine) o.volunteer_count = volunteerCount; else o.i_volunteered = iVolunteered;
  return o;
}

async function listMine({ employee }) {
  const [mine, incoming, offers] = await Promise.all([
    ShiftConstraint.find({ employee_id: employee._id }).sort({ date: -1 }).limit(100),
    ShiftConstraint.find({ colleague_id: employee._id, status: 'pending_colleague' }).sort({ date: 1 }),
    ShiftConstraint.find({ branch_id: employee.branch_id, status: 'broadcast', employee_id: { $ne: employee._id } }).sort({ date: 1 }),
  ]);
  return {
    mine: mine.map(c => publicView(c, employee._id)),
    incoming: incoming.map(c => publicView(c, employee._id)),
    offers: offers.map(c => publicView(c, employee._id)),
  };
}

async function colleaguesOf({ employee }) {
  const rows = await Employee.find({ branch_id: employee.branch_id, is_active: true, _id: { $ne: employee._id } }).select('full_name').sort({ full_name: 1 }).lean();
  return rows.map(r => ({ _id: String(r._id), full_name: r.full_name }));
}

async function respondColleague({ employee, id, accept, now = new Date() }) {
  const c = await loadOr404(id);
  if (String(c.colleague_id) !== String(employee._id)) throw new ShiftError(403, 'הבקשה לא מיועדת לך');
  if (c.status !== 'pending_colleague') throw new ShiftError(409, 'הבקשה כבר טופלה');
  // A week that has started, or whose rota is already out, has nothing left to swap into.
  const started = weekStart(c.date) <= weekStart(ilNow(now).day);
  const published = !started && await ShiftWeek.exists({ branch_id: c.branch_id, week_start: c.week_start, published_at: { $ne: null } });
  if (started || published) throw new ShiftError(409, 'הבקשה כבר לא רלוונטית');
  c.status = accept ? 'open' : 'declined';
  await c.save();
  await notifyEmployee(c.employee_id, {
    type: 'swap_response', ref_collection: 'ShiftConstraint', ref_id: c._id,
    title: accept ? `${employee.full_name} הסכימה להחלפה` : `${employee.full_name} לא יכולה להחליף`,
    body: accept ? 'הבקשה עברה למנהלת הסניף' : `ב-${label(c.date)}`, url: '/my-shifts?tab=constraints',
  });
  return publicView(c, employee._id);
}

async function volunteer({ employee, id }) {
  const c = await loadOr404(id);
  if (String(c.branch_id) !== String(employee.branch_id) || String(c.employee_id) === String(employee._id)) throw new ShiftError(403, 'ההצעה לא זמינה לך');
  if (c.status !== 'broadcast') throw new ShiftError(409, c.status === 'pending_broadcast' ? 'ההצעה עוד לא נשלחה' : 'ההצעה כבר נסגרה');
  await ShiftConstraint.updateOne({ _id: c._id }, { $addToSet: { volunteers: employee._id } });
  return { ok: true };
}

async function cancelConstraint({ employee, id }) {
  const c = await loadOr404(id);
  if (String(c.employee_id) !== String(employee._id)) throw new ShiftError(403, 'זה לא האילוץ שלך');
  if (['rejected', 'declined', 'cancelled'].includes(c.status)) throw new ShiftError(409, 'האילוץ כבר סגור');
  const wasLive = ['accepted', 'open'].includes(c.status);
  if (c.employee_request_id) {
    const er = await EmployeeRequest.findById(c.employee_request_id);
    if (er && er.status === 'approved') throw new ShiftError(409, 'הבקשה כבר אושרה בהנהלת החשבונות — פני למשרד');
    if (er && er.status !== 'rejected') {
      er.status = 'rejected';
      er.reason = `${er.reason || ''} (בוטל על ידי העובדת)`.trim();
      await er.save();
    }
  }
  const week = await ShiftWeek.findOne({ branch_id: c.branch_id, week_start: c.week_start }).select('published_at').lean();
  const afterPublish = !!(week && week.published_at);
  c.status = 'cancelled'; c.cancelled_at = new Date(); c.cancelled_after_publish = afterPublish;
  await c.save();
  if (afterPublish) {
    for (const recipient_id of await managersOf(c.branch_id)) {
      await notificationService.notifyOnce({
        type: 'constraint_cancelled', ref_collection: 'ShiftConstraint', ref_id: c._id, recipient_id,
        title: `${c.employee_name} ביטלה אילוץ`, body: `ב-${label(c.date)} — הסידור לשבוע הזה כבר פורסם`,
        url: `/shifts?week=${c.week_start}`,
      }).catch(err => console.error('[constraints] notify failed:', err.message));
    }
  }
  if (c.type === 'swap' && c.colleague_id && wasLive) {
    await notifyEmployee(c.colleague_id, {
      type: 'swap_response', ref_collection: 'ShiftConstraint', ref_id: c._id,
      title: `${c.employee_name} ביטלה את בקשת ההחלפה`, body: `ב-${label(c.date)}`, url: '/my-shifts?tab=constraints',
    });
  }
  return { constraint: publicView(c, employee._id), after_publish: afterPublish };
}

/** Accept: the EmployeeRequest that carries a day off or a sick day on to accounting. */
async function acceptInto(c, user, auto) {
  c.status = 'accepted'; c.decided_by = user.id; c.decided_by_name = user.full_name || ''; c.decided_at = new Date(); c.decided_auto = !!auto;
  const requestType = { day_off: 'vacation', sick_expected: 'sick' }[c.type];
  if (requestType && !c.employee_request_id) {
    const emp = await Employee.findById(c.employee_id).select('user_id branch_id').lean();
    const medical = {};
    const file = requestType === 'sick' && (c.files || [])[0];
    if (file) {
      medical.medical_file_data = file.storage_key
        ? (await storage.getObject(file.storage_key)).toString('base64')
        : file.file_data || null;
      medical.medical_file_name = file.name;
    }
    const er = await EmployeeRequest.create({
      user_id: emp ? emp.user_id || null : null, employee_id: c.employee_id, branch_id: c.branch_id,
      type: requestType, from_date: c.date, to_date: c.date, reason: `אילוץ: ${c.details}`.slice(0, 500),
      status: 'pending_accountant', manager_reviewed_by: user.id, manager_reviewed_at: new Date(),
      ...medical,
    });
    c.employee_request_id = er._id;
  }
  await c.save();
  await notifyEmployee(c.employee_id, {
    type: 'constraint_decision', ref_collection: 'ShiftConstraint', ref_id: c._id,
    title: 'האילוץ שלך התקבל', body: `ב-${label(c.date)}`, url: '/my-shifts?tab=constraints',
  });
}

/** A swap's other side hears the manager's decision too. */
async function notifySwapColleague(c, accepted) {
  if (c.type !== 'swap' || !c.colleague_id) return;
  await notifyEmployee(c.colleague_id, {
    type: 'constraint_decision', ref_collection: 'ShiftConstraint', ref_id: c._id,
    title: accepted ? 'ההחלפה אושרה' : 'ההחלפה לא אושרה',
    body: `ב-${label(c.date)} — ${c.employee_name}`, url: '/my-shifts?tab=constraints',
  });
}

async function decide({ user, id, accept, reason, confirmFar, now = new Date() }) {
  const c = await loadOr404(id);
  assertEdit(user, c.branch_id);
  if (!ACTIONABLE.has(c.status)) throw new ShiftError(409, 'האילוץ כבר טופל');
  if (!accept) {
    const why = String(reason || '').trim();
    if (!why) throw new ShiftError(400, 'יש לכתוב סיבה לדחייה');
    c.status = 'rejected'; c.reject_reason = why.slice(0, 500);
    c.decided_by = user.id; c.decided_by_name = user.full_name || ''; c.decided_at = new Date();
    await c.save();
    await notifyEmployee(c.employee_id, {
      type: 'constraint_decision', ref_collection: 'ShiftConstraint', ref_id: c._id,
      title: 'האילוץ שלך לא התקבל', body: c.reject_reason, url: '/my-shifts?tab=constraints',
    });
    await notifySwapColleague(c, false);
    return withoutFileBytes(c);
  }
  if (c.status !== 'open') throw new ShiftError(409, 'בהחלפה פתוחה לכל הסניף יש לבחור מתנדבת');
  if (isFarFuture(c.date, now) && !confirmFar) throw new ShiftError(409, 'אילוץ לשבוע רחוק — יש לאשר שהפעולה סופית', { needs_confirm: true });
  await acceptInto(c, user, false);
  await notifySwapColleague(c, true);
  return withoutFileBytes(c);
}

async function approveBroadcast({ user, id }) {
  const c = await loadOr404(id);
  assertEdit(user, c.branch_id);
  if (c.status !== 'pending_broadcast') throw new ShiftError(409, 'האילוץ כבר טופל');
  c.status = 'broadcast';
  await c.save();
  const staff = await Employee.find({ branch_id: c.branch_id, is_active: true, _id: { $ne: c.employee_id }, user_id: { $ne: null } }).select('user_id').lean();
  await Promise.all(staff.map(s => notificationService.notifyOnce({
    type: 'swap_offer', ref_collection: 'ShiftConstraint', ref_id: c._id, recipient_id: s.user_id,
    title: 'מישהי יכולה להחליף?', body: `נדרשת החלפה ב-${label(c.date)}`, url: '/my-shifts?tab=constraints',
  }).catch(err => console.error('[constraints] notify failed:', err.message))));
  return withoutFileBytes(c);
}

async function pickVolunteer({ user, id, employeeId }) {
  const c = await loadOr404(id);
  assertEdit(user, c.branch_id);
  if (c.status !== 'broadcast') throw new ShiftError(409, 'אין הצעה פתוחה');
  if (!c.volunteers.some(v => String(v) === String(employeeId))) throw new ShiftError(400, 'העובדת לא התנדבה');
  if (!await Employee.exists({ _id: employeeId, branch_id: c.branch_id, is_active: true })) throw new ShiftError(400, 'העובדת לא פעילה בסניף');
  c.colleague_id = employeeId;
  await acceptInto(c, user, false);
  await notifyEmployee(employeeId, {
    type: 'swap_picked', ref_collection: 'ShiftConstraint', ref_id: c._id,
    title: 'נבחרת להחלפה', body: `ב-${label(c.date)} במקום ${c.employee_name}`, url: '/my-shifts',
  });
  return withoutFileBytes(c);
}

/** The week's live constraints for the board, volunteers spelled out for the manager. */
async function forBoard({ branchId, dates, entries }) {
  const list = await ShiftConstraint.find({
    branch_id: branchId,
    status: { $in: ['open', 'pending_broadcast', 'broadcast', 'accepted'] },
    $or: [{ date: { $in: dates } }, { target_date: { $in: dates } }],
  }).sort({ date: 1, created_at: 1 }).lean();
  const ids = [...new Set(list.flatMap(c => [...(c.volunteers || []), c.colleague_id].filter(Boolean).map(String)))];
  const names = new Map((await Employee.find({ _id: { $in: ids } }).select('full_name').lean()).map(e => [String(e._id), e.full_name]));
  return list.map(c => ({
    ...c,
    files: (c.files || []).map(f => ({ name: f.name, mimetype: f.mimetype, size: f.size })),
    colleague_name: c.colleague_id ? names.get(String(c.colleague_id)) || '' : '',
    volunteers: (c.volunteers || []).map(v => ({
      employee_id: String(v), full_name: names.get(String(v)) || '',
      free_that_day: !(entries || []).some(e => String(e.employee_id) === String(v) && e.date === c.date),
    })),
  }));
}

async function listFuture({ user, branchId, now = new Date() }) {
  if (!canView(user, branchId)) throw new ShiftError(403, 'אין הרשאה לסניף הזה');
  const after = addDays(weekStart(ilNow(now).day), 7);
  const list = await ShiftConstraint.find({ branch_id: branchId, week_start: { $gt: after }, status: { $in: ['open', 'pending_broadcast', 'broadcast'] } }).sort({ date: 1 }).lean();
  return list.map(c => ({ ...c, files: (c.files || []).map(f => ({ name: f.name, mimetype: f.mimetype, size: f.size })), volunteers: undefined, volunteer_count: (c.volunteers || []).length }));
}

/** Accepted constraints of these employees on these dates — whichever branch they were filed at. */
async function acceptedFor({ employeeIds, dates }) {
  if (!(employeeIds || []).length) return [];
  return ShiftConstraint.find({ employee_id: { $in: employeeIds }, status: 'accepted', date: { $in: dates } }).lean();
}

/**
 * Before a publish: auto-accept what the rota already respects; refuse the
 * publish while anything else of the week is undecided.
 */
async function resolveForPublish({ user, week, entries }) {
  const live = await ShiftConstraint.find({ branch_id: week.branch_id, week_start: week.week_start, status: { $in: ['open', 'pending_broadcast', 'broadcast'] } });
  // Respected means in every branch's week: a day off at home is not kept while she works at the host.
  const people = [...new Set(live.flatMap(c => [c.employee_id, c.colleague_id].filter(Boolean).map(String)))];
  const elsewhere = people.length ? await otherBranchEntries({ weekStart: week.week_start, employeeIds: people, excludeBranchId: week.branch_id }) : [];
  const everywhere = [...entries, ...elsewhere];
  const auto = live.filter(c => c.status === 'open' && respected(c, everywhere) === true);
  const blocking = live.filter(c => !auto.includes(c));
  if (blocking.length) {
    throw new ShiftError(409, `יש ${blocking.length} אילוצים שלא טופלו — יש לאשר או לדחות לפני סגירת הסידור`, { open_constraints: blocking.map(c => String(c._id)) });
  }
  // An accepted constraint is a promise already made: the published rota must
  // keep it. Checked before anything is auto-accepted, so a refused publish
  // changes nothing.
  const accepted = await acceptedFor({ employeeIds: [...new Set(entries.map(e => String(e.employee_id)))], dates: weekDays(week.week_start) });
  for (const e of entries) {
    if (accepted.some(c => blocksEntry(c, e))) {
      throw new ShiftError(409, `${e.employee_name || 'עובדת'} משובצת ב-${e.date} למרות אילוץ מאושר — יש להסיר את השיבוץ לפני הסגירה`);
    }
  }
  for (const c of auto) await acceptInto(c, user, true);
  return auto.length;
}

async function readFile({ user, employee, id, index }) {
  const c = await loadOr404(id);
  const owner = employee && String(c.employee_id) === String(employee._id);
  if (!owner && !(user && canView(user, c.branch_id))) throw new ShiftError(403, 'אין הרשאה לקובץ');
  const f = c.files[Number(index)];
  if (!f) throw new ShiftError(404, 'קובץ לא נמצא');
  const buffer = f.storage_key ? await storage.getObject(f.storage_key) : Buffer.from(f.file_data || '', 'base64');
  return { name: f.name, mimetype: f.mimetype, buffer };
}

module.exports = {
  createConstraint, listMine, colleaguesOf, respondColleague, volunteer, cancelConstraint,
  decide, approveBroadcast, pickVolunteer, forBoard, listFuture, acceptedFor, resolveForPublish, readFile,
  FINAL,
};
