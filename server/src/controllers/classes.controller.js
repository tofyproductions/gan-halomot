const { ClassProvider, ClassProgram, ClassSession, Classroom, Branch } = require('../models');
const { getBranchFilter } = require('../utils/branch-filter');
const classSessions = require('../services/classSessions.service');
const retainer = require('../services/classRetainer.service');
const classPayments = require('../services/classPayments.service');

const userId = (req) => (req.user && (req.user.id || req.user._id)) || null;

// A body's branch must sit inside the caller's scope exactly like a ?branch
// would (the middleware only clamps the query string, not POST bodies).
function assertBranchInScope(req, branchId) {
  const scope = req.branchScope;
  if (Array.isArray(scope) && !scope.map(String).includes(String(branchId))) {
    throw Object.assign(new Error('הסניף מחוץ להרשאות שלך'), { status: 403 });
  }
}

/** Accept a billing block from the screen, keeping only what the model knows. */
function billingOf(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const ym = (v) => (/^\d{4}-\d{2}$/.test(String(v || '')) ? String(v) : '');
  return {
    mode: raw.mode === 'monthly' ? 'monthly' : 'per_session',
    monthly_fee: Math.max(0, Number(raw.monthly_fee) || 0),
    meetings_per_month: Math.max(1, Number(raw.meetings_per_month) || 4),
    period_start: ym(raw.period_start),
    period_end: ym(raw.period_end),
  };
}

// Accept only a YYYY-MM month before it becomes a $regex, so a crafted value
// can neither broaden the date filter nor pin the server with catastrophic
// backtracking (ReDoS).
function monthPrefixFilter(month) {
  const m = String(month || '');
  return /^\d{4}-\d{2}$/.test(m) ? { $regex: `^${m}` } : undefined;
}

// --- Israel-local "now" (date + HH:mm) for the occurrence popup ------------
function israelNow() {
  const now = new Date();
  const ymd = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }); // YYYY-MM-DD
  const hhmm = now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' });
  return { ymd, hhmm };
}

// Branch scope a manager/accountant may see (system_admin → all).
function managedBranchIds(req) {
  const role = req.user?.role;
  if (role === 'system_admin' || role === 'accountant') return null; // null = all
  const managed = (req.user?.managed_branch_ids || []).map(String);
  const fallback = req.user?.branch_id ? [String(req.user.branch_id)] : [];
  return managed.length ? managed : fallback;
}

// ========================= Providers =========================
async function listProviders(req, res, next) {
  try {
    const filter = {};
    if (req.query.active === 'true') filter.is_active = true;
    const providers = await ClassProvider.find(filter).sort({ name: 1 }).lean();
    res.json({ providers });
  } catch (err) { next(err); }
}
async function createProvider(req, res, next) {
  try {
    const { name, field, phone, email, notes, branch_ids, vat_mode } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'שם ספק נדרש' });
    const provider = await ClassProvider.create({
      name: String(name).trim(), field: field || '', phone: phone || '', email: email || '', notes: notes || '',
      branch_ids: Array.isArray(branch_ids) ? branch_ids.filter(Boolean) : [],
      vat_mode: vat_mode === 'registered' ? 'registered' : 'exempt',
    });
    res.status(201).json({ provider });
  } catch (err) { next(err); }
}
async function updateProvider(req, res, next) {
  try {
    const fields = ['name', 'field', 'phone', 'email', 'notes', 'is_active', 'branch_ids', 'vat_mode'];
    const update = {};
    for (const f of fields) if (req.body[f] !== undefined) update[f] = req.body[f];
    if (Array.isArray(update.branch_ids)) update.branch_ids = update.branch_ids.filter(Boolean);
    if (update.vat_mode !== undefined) {
      update.vat_mode = update.vat_mode === 'registered' ? 'registered' : 'exempt';
    }
    if (req.body.billing !== undefined) {
      // The monthly retainer is money — a change to it is accounting's act,
      // exactly as the routes-file comment promises.
      const nextBilling = billingOf(req.body.billing);
      const current = await ClassProvider.findById(req.params.id).select('billing').lean();
      if (!current) return res.status(404).json({ error: 'ספק לא נמצא' });
      const changed = JSON.stringify(current.billing || null) !== JSON.stringify(nextBilling || null);
      if (changed && !['system_admin', 'accountant'].includes(req.user?.role)) {
        return res.status(403).json({ error: 'שינוי הסכם הריטיינר — הנהלת חשבונות בלבד' });
      }
      update.billing = nextBilling;
    }
    const provider = await ClassProvider.findByIdAndUpdate(req.params.id, update, { new: true }).lean();
    if (!provider) return res.status(404).json({ error: 'ספק לא נמצא' });
    res.json({ provider });
  } catch (err) { next(err); }
}
async function deleteProvider(req, res, next) {
  try {
    await ClassProvider.findByIdAndUpdate(req.params.id, { is_active: false });
    res.json({ ok: true });
  } catch (err) { next(err); }
}

/**
 * PUT /classes/providers/:id/schedule
 *
 * One provider's whole working arrangement, saved in a single call: which
 * branches she comes to, and for each branch which classroom groups she takes,
 * on what day, at what time and for how much.
 *
 * It exists because the arrangement is ONE decision and was four screens. A
 * provider who takes תינוקייה and צעירים at two branches is four ClassPrograms,
 * created one dialog at a time, with the branch and the instructor's name
 * retyped on each — and if the third is forgotten nothing says so, there is
 * simply a group that never gets a session and never gets paid for.
 *
 * Rows carrying an `_id` are updated, rows without one are created, and a
 * program of this provider that the caller did not send back is DEACTIVATED
 * rather than deleted: its past sessions are what the month was paid on, and
 * deleting the program would orphan them.
 */
async function setProviderSchedule(req, res, next) {
  try {
    const provider = await ClassProvider.findById(req.params.id);
    if (!provider) return res.status(404).json({ error: 'ספק לא נמצא' });

    const body = req.body || {};
    /**
     * The caller's reach: a branch manager edits HER branches' rows of the
     * shared provider; rows of branches outside her scope are ignored (not
     * written, and — below — not swept off either), so the dialog's full
     * round-trip stays harmless. Admin/accountant (scope null) edit all.
     */
    const scope = Array.isArray(req.branchScope) ? req.branchScope.map(String) : null;
    const inScope = (bid) => !scope || scope.includes(String(bid));
    const allRows = Array.isArray(body.rows) ? body.rows : [];
    const rows = allRows.filter(r => r.branch_id && inScope(r.branch_id));

    // The branches are taken from the rows themselves when the caller did not
    // state them — the arrangement is the truth, and a branch list that
    // disagrees with it is the kind of thing nobody notices for a term.
    // A scoped caller's list keeps the other branches she cannot speak for.
    const fromRows = [...new Set(rows.map(r => String(r.branch_id || '')).filter(Boolean))];
    const requested = Array.isArray(body.branch_ids) && body.branch_ids.length
      ? [...new Set(body.branch_ids.filter(Boolean).map(String))].filter(inScope)
      : fromRows;
    const preserved = scope ? (provider.branch_ids || []).map(String).filter(b => !scope.includes(b)) : [];
    provider.branch_ids = [...new Set([...preserved, ...requested])];
    if (body.vat_mode !== undefined) {
      provider.vat_mode = body.vat_mode === 'registered' ? 'registered' : 'exempt';
    }
    if (body.billing !== undefined) {
      // Same rule as updateProvider: retainer money moves only by accounting.
      const nextBilling = billingOf(body.billing);
      const changed = JSON.stringify(provider.billing ? provider.toObject().billing : null) !== JSON.stringify(nextBilling || null);
      if (changed && !['system_admin', 'accountant'].includes(req.user?.role)) {
        return res.status(403).json({ error: 'שינוי הסכם הריטיינר — הנהלת חשבונות בלבד' });
      }
      provider.billing = nextBilling;
    }
    await provider.save();

    const kept = [];
    for (const r of rows) {
      if (!r.branch_id) continue;
      const fields = {
        branch_id: r.branch_id,
        provider_id: provider._id,
        name: String(r.name || provider.name).trim(),
        instructor_name: r.instructor_name || '',
        ...categoriesOf(r),
        classroom_id: r.classroom_id || null,
        default_rate: Number(r.default_rate) || 0,
        default_day: r.default_day === '' || r.default_day == null ? null : Number(r.default_day),
        default_time: r.default_time || '',
        is_active: true,
      };
      if (r._id) {
        const updated = await ClassProgram.findOneAndUpdate(
          { _id: r._id, provider_id: provider._id }, fields, { new: true },
        ).lean();
        if (updated) kept.push(String(updated._id));
      } else {
        const created = await ClassProgram.create(fields);
        kept.push(String(created._id));
      }
    }

    // Anything of this provider's that is no longer in the arrangement —
    // inside the caller's own branches only. Another branch's programs are
    // not hers to switch off.
    const sweep = { provider_id: provider._id, is_active: true, _id: { $nin: kept } };
    if (scope) sweep.branch_id = { $in: scope };
    await ClassProgram.updateMany(sweep, { is_active: false });

    const programs = await ClassProgram.find({ provider_id: provider._id, is_active: true })
      .sort({ branch_id: 1, default_day: 1, default_time: 1 }).lean();
    res.json({ provider: provider.toObject(), programs });
  } catch (err) { next(err); }
}

/**
 * GET /classes/providers/:id/settlement?as_of=YYYY-MM
 *
 * For a provider on a monthly retainer: what was paid, what was held, and who
 * owes whom — to date, and forecast to the end of the agreed period.
 */
async function providerSettlement(req, res, next) {
  try {
    const provider = await ClassProvider.findById(req.params.id).lean();
    if (!provider) return res.status(404).json({ error: 'ספק לא נמצא' });
    const asOf = /^\d{4}-\d{2}$/.test(String(req.query.as_of || '')) ? req.query.as_of : undefined;
    res.json(await retainer.settlement(provider, asOf ? { asOf } : {}));
  } catch (err) { next(err); }
}

/** GET /classes/providers/:id/schedule — the arrangement, to edit it. */
async function getProviderSchedule(req, res, next) {
  try {
    const provider = await ClassProvider.findById(req.params.id).lean();
    if (!provider) return res.status(404).json({ error: 'ספק לא נמצא' });
    const programs = await ClassProgram.find({ provider_id: provider._id, is_active: true })
      .sort({ branch_id: 1, default_day: 1, default_time: 1 }).lean();
    res.json({ provider, programs });
  } catch (err) { next(err); }
}

/**
 * One shape for the groups a class serves, whichever way the caller sent them.
 *
 * Accepts the list or the old single value, and always returns BOTH — the list
 * is the truth and the singular is the first of it, because every screen and
 * query written before today reads the singular and must keep working.
 */
function categoriesOf(body) {
  const list = Array.isArray(body.classroom_categories)
    ? body.classroom_categories
    : (body.classroom_category ? [body.classroom_category] : []);
  const clean = [...new Set(list.map(c => String(c || '').trim()).filter(Boolean))];
  return { classroom_categories: clean, classroom_category: clean[0] || '' };
}

/** "תינוקייה + צעירים" — what a combined meeting is called on screen. */
function categoryLabel(program) {
  const list = Array.isArray(program?.classroom_categories) && program.classroom_categories.length
    ? program.classroom_categories
    : (program?.classroom_category ? [program.classroom_category] : []);
  return list.join(' + ');
}

// ========================= Programs (חוגים) =========================
async function listPrograms(req, res, next) {
  try {
    // Clamped to the caller's branches; ?branch may only narrow within them
    // (attachBranchScope has already refused anything outside).
    const filter = { ...getBranchFilter(req, 'branch_id') };
    if (req.query.active === 'true') filter.is_active = true;
    const programs = await ClassProgram.find(filter)
      .populate('provider_id', 'name phone field vat_mode billing')
      .sort({ name: 1 }).lean();
    res.json({ programs });
  } catch (err) { next(err); }
}
async function createProgram(req, res, next) {
  try {
    const b = req.body || {};
    if (!b.branch_id || !b.name) return res.status(400).json({ error: 'סניף ושם חוג נדרשים' });
    assertBranchInScope(req, b.branch_id);
    const program = await ClassProgram.create({
      branch_id: b.branch_id,
      provider_id: b.provider_id || null,
      name: String(b.name).trim(),
      instructor_name: b.instructor_name || '',
      ...categoriesOf(b),
      classroom_id: b.classroom_id || null,
      default_rate: Number(b.default_rate) || 0,
      default_day: b.default_day == null || b.default_day === '' ? null : Number(b.default_day),
      default_time: b.default_time || '',
      color: b.color || '#fce7f3',
    });
    res.status(201).json({ program });
  } catch (err) { next(err); }
}
async function updateProgram(req, res, next) {
  try {
    const fields = ['provider_id', 'name', 'instructor_name', 'classroom_id',
      'default_rate', 'default_day', 'default_time', 'color', 'is_active'];
    const update = {};
    for (const f of fields) if (req.body[f] !== undefined) update[f] = req.body[f];
    if (req.body.classroom_categories !== undefined || req.body.classroom_category !== undefined) {
      Object.assign(update, categoriesOf(req.body));
    }
    if (update.default_day === '' ) update.default_day = null;
    // "בלי ספק" arrives from the dialog as an empty string, and Mongo refuses
    // to cast '' to an ObjectId — the whole edit died on it.
    if (update.provider_id === '') update.provider_id = null;
    if (update.classroom_id === '') update.classroom_id = null;
    const existing = await ClassProgram.findById(req.params.id).select('branch_id').lean();
    if (!existing) return res.status(404).json({ error: 'חוג לא נמצא' });
    assertBranchInScope(req, existing.branch_id);
    const program = await ClassProgram.findByIdAndUpdate(req.params.id, update, { new: true }).lean();
    res.json({ program });
  } catch (err) { next(err); }
}
async function deleteProgram(req, res, next) {
  try {
    /**
     * Removing a class is also a statement about its money: the month's
     * meetings — including ones already ticked "התקיים" — must stop billing,
     * or the payment summary keeps charging for a class that no longer
     * exists (קפלן's תנועלולה did exactly that). Past months stay: they are
     * history, possibly already invoiced and paid.
     */
    const prog = await ClassProgram.findById(req.params.id).select('branch_id').lean();
    if (!prog) return res.status(404).json({ error: 'חוג לא נמצא' });
    assertBranchInScope(req, prog.branch_id);
    await ClassProgram.findByIdAndUpdate(req.params.id, { is_active: false });
    const monthStart = `${classSessions.monthOf(new Date())}-01`;
    const { deletedCount } = await ClassSession.deleteMany({
      program_id: req.params.id, date: { $gte: monthStart },
    });
    res.json({ ok: true, sessions_removed: deletedCount || 0 });
  } catch (err) { next(err); }
}

// ========================= Sessions =========================
// GET /classes/sessions?branch=&month=YYYY-MM  OR  ?program_id=
async function listSessions(req, res, next) {
  try {
    const filter = { ...getBranchFilter(req, 'branch_id') };
    if (req.query.program_id) filter.program_id = req.query.program_id;
    const monthFilter = monthPrefixFilter(req.query.month);
    if (monthFilter) filter.date = monthFilter;
    const sessions = await ClassSession.find(filter)
      .populate('program_id', 'name instructor_name color default_rate provider_id classroom_category classroom_categories')
      .sort({ date: 1, time: 1 }).lean();
    res.json({ sessions });
  } catch (err) { next(err); }
}

// Create one session (defaults inherited from the program).
async function createSession(req, res, next) {
  try {
    const b = req.body || {};
    const program = await ClassProgram.findById(b.program_id).lean();
    if (!program) return res.status(404).json({ error: 'חוג לא נמצא' });
    assertBranchInScope(req, program.branch_id);
    if (!b.date) return res.status(400).json({ error: 'תאריך נדרש' });
    const session = await ClassSession.create({
      program_id: program._id,
      branch_id: program.branch_id,
      classroom_id: b.classroom_id || program.classroom_id || null,
      date: b.date,
      time: b.time || program.default_time || '',
      rate: b.rate != null && b.rate !== '' ? Number(b.rate) : (Number(program.default_rate) || 0),
      status: 'scheduled',
    });
    res.status(201).json({ session });
  } catch (err) { next(err); }
}

// Bulk-create sessions from an explicit list of dates (the common case:
// enter the month's meeting dates once). Each inherits program defaults.
async function generateSessions(req, res, next) {
  try {
    const { program_id, dates } = req.body || {};
    if (!program_id || !Array.isArray(dates) || dates.length === 0) {
      return res.status(400).json({ error: 'חוג ורשימת תאריכים נדרשים' });
    }
    const program = await ClassProgram.findById(program_id).lean();
    if (!program) return res.status(404).json({ error: 'חוג לא נמצא' });
    assertBranchInScope(req, program.branch_id);
    const docs = dates.filter(Boolean).map(d => ({
      program_id: program._id,
      branch_id: program.branch_id,
      classroom_id: program.classroom_id || null,
      date: d,
      time: program.default_time || '',
      rate: Number(program.default_rate) || 0,
      status: 'scheduled',
    }));
    const created = await ClassSession.insertMany(docs);
    res.status(201).json({ created: created.length });
  } catch (err) { next(err); }
}

/**
 * POST /classes/sessions/fill-month  { month, program_id? }
 *
 * Writes the month's meetings from the fixed day on each class. Safe to press
 * twice: a date that already has a session is left exactly as it is, answered
 * or not.
 */
async function fillMonth(req, res, next) {
  try {
    const { month, program_id: programId, include_past: includePast } = req.body || {};
    // Clamped to the caller's branches — a manager may not fill a month at a
    // branch she cannot see.
    const scope = managedBranchIds(req);
    const result = await classSessions.fillMonth({
      month,
      programId: programId || null,
      branchIds: scope,
      // Only when somebody deliberately reconstructs a month that has passed.
      includePast: includePast === true,
    });
    res.json(result);
  } catch (err) { next(err); }
}

/**
 * GET /classes/closed-days?branch=&month=
 * The dates the branch is shut this month, with the holiday's name — so the
 * board can say "סוכות" where a week has no meeting, instead of a silent gap
 * that looks like somebody forgot to fill the month.
 */
async function closedDays(req, res, next) {
  try {
    const { branch, month } = req.query;
    if (!branch || branch === 'all' || !/^\d{4}-\d{2}$/.test(month || '')) {
      return res.json({ closed: [] });
    }
    const map = await classSessions.closedDaysOf(branch, month);
    res.json({ closed: [...map.entries()].sort().map(([date, name]) => ({ date, name })) });
  } catch (err) { next(err); }
}

async function updateSession(req, res, next) {
  try {
    const fields = ['date', 'time', 'rate', 'classroom_id'];
    const update = {};
    for (const f of fields) if (req.body[f] !== undefined) update[f] = req.body[f];
    const existing = await ClassSession.findById(req.params.id).select('branch_id').lean();
    if (!existing) return res.status(404).json({ error: 'מפגש לא נמצא' });
    assertBranchInScope(req, existing.branch_id);
    const session = await ClassSession.findByIdAndUpdate(req.params.id, update, { new: true }).lean();
    res.json({ session });
  } catch (err) { next(err); }
}

async function deleteSession(req, res, next) {
  try {
    const session = await ClassSession.findById(req.params.id).select('branch_id').lean();
    if (!session) return res.json({ ok: true });
    assertBranchInScope(req, session.branch_id);
    await ClassSession.deleteOne({ _id: req.params.id });
    res.json({ ok: true });
  } catch (err) { next(err); }
}

// Is this user the lead of the session's classroom?
async function isClassLead(req, session) {
  if (!session.classroom_id) return false;
  const room = await Classroom.findById(session.classroom_id).select('lead_teacher_id').lean();
  return room && String(room.lead_teacher_id) === String(req.user?.id);
}
/** May this caller answer for a session, and does answering CONFIRM it. */
function isManagerRole(req) {
  return ['system_admin', 'branch_manager', 'accountant'].includes(req.user?.role);
}

/**
 * Who the occurrence popup is FOR — which is a narrower question than who may
 * answer it.
 *
 * The branch manager is in the building. She knows whether the instructor
 * walked in, and the question costs her two seconds. A system admin or an
 * accountant is not there, cannot know, and was being asked anyway — about
 * every class at every branch, every morning. A popup somebody cannot answer
 * is a popup they learn to close, and once it is closed on reflex it is also
 * closed on the morning it mattered.
 *
 * They keep every power they had: the tracking screen, and marking a session
 * from it. What they stop getting is the interruption.
 */
function getsOccurrencePopup(req) {
  return req.user?.role === 'branch_manager';
}

/**
 * POST /classes/sessions/:id/answer
 * Body: { arrived: bool, reason?, reschedule?: bool, new_date? }
 * Records the popup answer. The branch manager's confirmation is always
 * required; if only the class lead answers, manager_confirmed stays false.
 * A reschedule creates a NEW scheduled session and marks this one 'postponed'
 * (never counted for payment).
 */
/**
 * Record one answer on one session.
 *
 * Shared by the single-session route and by the visit answer, because the
 * rules are the same either way and the only thing that differs is how many
 * sessions the person is looking at.
 *
 * `status` is the new form; `arrived` is the old boolean and is still accepted,
 * because a browser left open across the deploy will keep sending it.
 */
async function applyAnswer(session, body, { manager, lead, userId }) {
  const raw = body || {};
  let status = raw.status;
  if (!status) status = raw.arrived ? 'occurred' : (raw.reschedule && raw.new_date ? 'postponed' : 'no_show');

  if (manager) { session.answered_by_manager = true; session.manager_confirmed = true; }
  if (lead) session.answered_by_lead = true;
  session.responder_id = userId || null;
  session.responded_at = new Date();

  if (status === 'occurred') {
    session.status = 'occurred';
    session.partial_amount = null;
    session.no_show_reason = '';
  } else if (status === 'partial') {
    session.status = 'partial';
    // Half the rate is the common case and the default, but the number is
    // whatever was actually agreed — the old sheet's corrections were never
    // halves, they were "one group of three did not happen".
    // Clamped to [0, rate]: "partial" can never bill MORE than the whole
    // meeting — the amount is a correction downward, not a free number.
    const rate = Number(session.rate) || 0;
    const amt = Number(raw.partial_amount);
    session.partial_amount = Number.isFinite(amt) && amt >= 0
      ? Math.min(amt, rate)
      : Math.round((rate / 2) * 100) / 100;
    session.no_show_reason = raw.reason || '';
  } else if (status === 'postponed' && raw.new_date) {
    /**
     * The make-up lesson, with its own hour.
     *
     * A lesson moved to another day is rarely moved to the same time — it
     * lands wherever the room was free. Carrying the original hour over looked
     * tidy and put the reminder at 09:00 on a day the instructor was coming at
     * 14:00, which is a question asked five hours early and answered wrong.
     */
    const replacement = await ClassSession.create({
      program_id: session.program_id,
      branch_id: session.branch_id,
      classroom_id: session.classroom_id,
      date: raw.new_date,
      time: raw.new_time || session.time,
      rate: session.rate,
      status: 'scheduled',
      postponed_from_session_id: session._id,
    });
    session.status = 'postponed';
    session.partial_amount = null;
    session.postponed_to_date = raw.new_date;
    session.postponed_to_session_id = replacement._id;
    session.no_show_reason = raw.reason || '';
  } else {
    session.status = 'no_show';
    session.partial_amount = null;
    session.no_show_reason = raw.reason || '';
  }
  await session.save();
  return session;
}

async function answerSession(req, res, next) {
  try {
    const session = await ClassSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: 'מפגש לא נמצא' });

    const manager = isManagerRole(req);
    const lead = await isClassLead(req, session);
    if (!manager && !lead) return res.status(403).json({ error: 'אין הרשאה לענות על מפגש זה' });
    // A manager's role is not a key to every branch: the session must sit in
    // one she manages (admin/accountant pass — scope null).
    if (manager && !lead) {
      const scope = managedBranchIds(req);
      if (scope && !scope.includes(String(session.branch_id))) {
        return res.status(403).json({ error: 'המפגש שייך לסניף שאינו בניהולך' });
      }
    }

    await applyAnswer(session, req.body, { manager, lead, userId: req.user?.id });
    res.json({ session });
  } catch (err) { next(err); }
}

/**
 * POST /classes/sessions/answer-visit
 *
 * One instructor, one branch, one morning, several classrooms — answered in
 * one go. The popup that drives this asks "did she come?" once and then ticks
 * each group, because that is how the morning actually happened and because
 * three popups in a row is how a manager learns to dismiss them.
 *
 * Every session is checked for permission on its own. A visit is not a unit of
 * authority: a class lead may answer for her own room inside it and not for
 * the others, and what she is not allowed to touch is reported back rather
 * than silently skipped.
 */
async function answerVisit(req, res, next) {
  try {
    const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
    if (answers.length === 0) return res.status(400).json({ error: 'לא נשלחו תשובות' });

    const manager = isManagerRole(req);
    const saved = [];
    const refused = [];
    for (const a of answers) {
      const session = await ClassSession.findById(a.id);
      if (!session) { refused.push({ id: a.id, reason: 'not_found' }); continue; }
      const lead = await isClassLead(req, session);
      if (!manager && !lead) { refused.push({ id: a.id, reason: 'forbidden' }); continue; }
      await applyAnswer(session, a, { manager, lead, userId: req.user?.id });
      saved.push(String(session._id));
    }
    if (saved.length === 0) {
      return res.status(403).json({ error: 'אין הרשאה לענות על המפגשים האלה', refused });
    }
    res.json({ saved: saved.length, refused });
  } catch (err) { next(err); }
}

/**
 * GET /classes/sessions/due
 *
 * What still needs answering, grouped into VISITS.
 *
 * An instructor arrives at one gan on one morning and takes the תינוקייה, then
 * the צעירים, then the בוגרים. Those are three sessions because they are three
 * groups at three rates — but they are ONE arrival, and asking a manager three
 * times in a row whether somebody came is how she learns to close the box
 * without reading it.
 *
 * So the question is asked once per (branch, provider, date) and the groups are
 * ticked inside it. Which is also the thing the old spreadsheet could not do:
 * it counted a DATE, so an instructor who came and skipped one group was paid
 * for all three and corrected by hand afterwards, in a row reading
 * "תשלום בחוסר שיעור" that explained nothing.
 *
 * Managers see their branches'; class leads see their own rooms'. A manager
 * still sees a session a lead has answered until she confirms it herself.
 */
async function dueSessions(req, res, next) {
  try {
    const { ymd, hhmm } = israelNow();
    const base = {
      status: 'scheduled',
      $or: [{ date: { $lt: ymd } }, { date: ymd, time: { $lte: hhmm } }, { date: ymd, time: '' }],
    };

    const populate = {
      path: 'program_id',
      select: 'name instructor_name classroom_category classroom_categories provider_id',
      populate: { path: 'provider_id', select: 'name' },
    };

    const manager = getsOccurrencePopup(req);
    let sessions = [];
    if (manager) {
      const scope = managedBranchIds(req);
      const filter = { ...base, manager_confirmed: { $ne: true } };
      if (scope) filter.branch_id = { $in: scope };
      sessions = await ClassSession.find(filter).populate(populate).lean();
    } else if (isManagerRole(req)) {
      // Management and accounting are not in the building; nothing is due
      // from them. The screen is still theirs.
      sessions = [];
    } else {
      const rooms = await Classroom.find({ lead_teacher_id: req.user?.id }).select('_id').lean();
      const roomIds = rooms.map(r => r._id);
      if (roomIds.length) {
        const filter = { ...base, classroom_id: { $in: roomIds }, answered_by_lead: { $ne: true } };
        sessions = await ClassSession.find(filter).populate(populate).lean();
      }
    }

    // Branch names, so the popup can say where when a manager runs more than one.
    const branchIds = [...new Set(sessions.map(s => String(s.branch_id)))];
    const branches = branchIds.length
      ? await Branch.find({ _id: { $in: branchIds } }).select('name').lean()
      : [];
    const branchName = Object.fromEntries(branches.map(b => [String(b._id), b.name]));

    const visits = new Map();
    for (const s of sessions) {
      const prog = s.program_id || {};
      const provider = prog.provider_id || null;
      // Grouped on the provider when there is one, and on the instructor's name
      // when there is not — a program may carry a name and no registered
      // provider, and those must not all collapse into one visit.
      const who = provider ? `p:${provider._id}` : `n:${prog.instructor_name || prog.name || '?'}`;
      const key = `${s.branch_id}|${who}|${s.date}`;
      if (!visits.has(key)) {
        visits.set(key, {
          key,
          branch_id: String(s.branch_id),
          branch_name: branchName[String(s.branch_id)] || '',
          provider_id: provider ? String(provider._id) : null,
          provider_name: provider?.name || '',
          instructor: prog.instructor_name || '',
          date: s.date,
          time: s.time || '',
          classes: [],
        });
      }
      const v = visits.get(key);
      if (s.time && (!v.time || s.time < v.time)) v.time = s.time;
      v.classes.push({
        id: String(s._id),
        program_name: prog.name || 'חוג',
        // "תינוקייה + צעירים" when they sit together: one meeting, one tick.
        classroom_category: categoryLabel(prog),
        time: s.time || '',
        // The price of the meeting is the manager's fact. A class lead
        // answering her own room's popup gets the question, not the money.
        ...(manager ? { rate: Number(s.rate) || 0 } : {}),
      });
    }

    const list = [...visits.values()].map(v => ({
      ...v,
      classes: v.classes.sort((a, b) => String(a.time).localeCompare(String(b.time))),
    })).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

    res.json({
      visits: list,
      // The flat list the previous popup read. Kept so a browser that has not
      // reloaded across the deploy still asks its questions instead of going
      // quiet, which would look exactly like "no classes today".
      sessions: list.flatMap(v => v.classes.map(c => ({
        id: c.id,
        program_name: c.program_name,
        instructor: v.instructor || v.provider_name,
        date: v.date,
        time: c.time,
      }))),
    });
  } catch (err) { next(err); }
}

/**
 * GET /classes/payment-summary?branch=&month=YYYY-MM
 *
 * What each provider is owed for the month.
 *
 * Grouped by PROVIDER rather than by class, because that is the number that
 * gets paid: one instructor who takes three groups at two rates sends one
 * invoice. The old spreadsheet worked the same way — a block per classroom
 * group, and then a "סיכום חיובים חודשי" that added the instructor up across
 * them — and the per-group rows are kept here under each provider for exactly
 * the reason that sheet kept them: so a number somebody questions can be taken
 * apart without reopening the month.
 *
 * Counted: a session that occurred, at its rate, plus a partial one at its
 * agreed amount. A no-show is nothing. A postponed session is nothing HERE and
 * something in the month it moved to — which is the whole point of postponing
 * rather than deleting, and why nobody is paid twice for one lesson.
 *
 * VAT is added only for a provider registered for it. The rate on a program is
 * always the pre-VAT figure, so `subtotal` is comparable across providers and
 * `total` is what leaves the bank.
 */
const VAT_RATE = 0.18;

async function paymentSummary(req, res, next) {
  try {
    const filter = { ...getBranchFilter(req, 'branch_id') };
    if (req.query.branch && req.query.branch !== 'all') filter.branch_id = req.query.branch;
    const monthFilter = monthPrefixFilter(req.query.month);
    if (monthFilter) filter.date = monthFilter;

    const sessions = await ClassSession.find(filter).populate({
      path: 'program_id',
      select: 'name instructor_name classroom_category classroom_categories provider_id branch_id',
      populate: { path: 'provider_id', select: 'name vat_mode billing' },
    }).lean();

    const branchIds = [...new Set(sessions.map(s => String(s.branch_id)))];
    const branches = branchIds.length
      ? await Branch.find({ _id: { $in: branchIds } }).select('name').lean()
      : [];
    const branchName = Object.fromEntries(branches.map(b => [String(b._id), b.name]));

    const byProvider = new Map();
    for (const s of sessions) {
      const prog = s.program_id || {};
      const provider = prog.provider_id || null;
      const pKey = provider ? String(provider._id) : `name:${prog.instructor_name || 'ללא ספק'}`;
      if (!byProvider.has(pKey)) {
        byProvider.set(pKey, {
          provider_id: provider ? String(provider._id) : null,
          provider_name: provider?.name || prog.instructor_name || 'ללא ספק',
          vat_mode: provider?.vat_mode || 'exempt',
          provider_doc: provider,
          programs: new Map(),
          subtotal: 0,
          held_by_branch: new Map(),   // raw group-sessions; made into visits below
        });
      }
      const p = byProvider.get(pKey);

      const gKey = String(prog._id || s.program_id);
      if (!p.programs.has(gKey)) {
        p.programs.set(gKey, {
          program_id: gKey,
          program_name: prog.name || 'חוג',
          classroom_category: categoryLabel(prog),
          branch_id: String(s.branch_id),
          branch_name: branchName[String(s.branch_id)] || '',
          rate: Number(s.rate) || 0,
          scheduled: 0, occurred: 0, partial: 0, no_show: 0, postponed: 0,
          amount: 0,
        });
      }
      const g = p.programs.get(gKey);
      g[s.status] = (g[s.status] || 0) + 1;

      let due = 0;
      if (s.status === 'occurred') due = Number(s.rate) || 0;
      else if (s.status === 'partial') {
        const amt = Number(s.partial_amount);
        due = Number.isFinite(amt) ? amt : 0;
      }
      g.amount += due;
      p.subtotal += due;
      const bk = String(s.branch_id);
      p.held_by_branch.set(bk, (p.held_by_branch.get(bk) || 0) + retainer.weightOf(s));
    }

    const round2 = (n) => Math.round(n * 100) / 100;
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? String(req.query.month) : '';
    // Retainer meetings are visits: each group's session is a share of one.
    const groupsOf = new Map();
    for (const p of byProvider.values()) {
      if (p.provider_doc && retainer.isRetainer(p.provider_doc)) {
        groupsOf.set(p.provider_id, await retainer.groupsPerVisit(p.provider_doc._id));
      }
    }
    const providers = [...byProvider.values()].map(p => {
      /**
       * A retainer is paid flat: the month's sum is the agreed fee, whatever
       * the calendar held. The meetings are still counted beside it — they are
       * what the year-end settlement is made of.
       */
      const onRetainer = p.provider_doc && retainer.isRetainer(p.provider_doc);
      let retainerInfo = null;
      if (onRetainer && month) {
        const b = p.provider_doc.billing;
        const fee = retainer.inPeriod(p.provider_doc, month) ? Number(b.monthly_fee) : 0;
        const groups = groupsOf.get(p.provider_id) || new Map();
        let held = 0;
        for (const [bk, w] of p.held_by_branch) held += w * retainer.visitShare(groups, bk);
        retainerInfo = {
          monthly_fee: Number(b.monthly_fee),
          meetings_per_month: Number(b.meetings_per_month) || 4,
          held_this_month: round2(held),
          in_period: fee > 0,
        };
        p.subtotal = fee;
      }
      const subtotal = round2(p.subtotal);
      const vat = p.vat_mode === 'registered' ? round2(subtotal * VAT_RATE) : 0;
      return {
        provider_id: p.provider_id,
        provider_name: p.provider_name,
        vat_mode: p.vat_mode,
        programs: [...p.programs.values()].map(g => ({ ...g, amount: round2(g.amount) })),
        retainer: retainerInfo,
        subtotal,
        vat,
        total: round2(subtotal + vat),
      };
    }).sort((a, b) => a.provider_name.localeCompare(b.provider_name, 'he'));

    res.json({
      month: req.query.month || '',
      vat_rate: VAT_RATE,
      providers,
      grand_subtotal: round2(providers.reduce((t, p) => t + p.subtotal, 0)),
      grand_vat: round2(providers.reduce((t, p) => t + p.vat, 0)),
      grand_total: round2(providers.reduce((t, p) => t + p.total, 0)),
      // The old per-program shape, so a screen that has not been reloaded
      // across the deploy keeps rendering instead of emptying out.
      summary: providers.flatMap(p => p.programs.map(g => ({
        program_id: g.program_id,
        program_name: g.program_name,
        instructor: p.provider_name,
        occurred: g.occurred, scheduled: g.scheduled,
        no_show: g.no_show, postponed: g.postponed,
        total_pay: g.amount,
      }))),
    });
  } catch (err) { next(err); }
}

// ========================= Payments (הנהלת חשבונות) =========================

/** The month's paid/invoice rows, clamped to the caller's branch scope like every read here. */
async function listPayments(req, res, next) {
  try {
    const filter = getBranchFilter(req, 'branch_id');
    const payments = await classPayments.listForMonth(filter, req.query.month);
    res.json({ month: req.query.month, payments });
  } catch (err) { next(err); }
}

/** שולם / לא שולם — the accountant's word, upserted per provider-month. */
async function markPayment(req, res, next) {
  try {
    const b = req.body || {};
    assertBranchInScope(req, b.branch_id);
    const payment = await classPayments.setPaid({
      branch_id: b.branch_id,
      month: b.month,
      provider_id: b.provider_id || null,
      provider_name: b.provider_name || '',
      paid: b.paid,
      by: userId(req),
    });
    res.json({ payment });
  } catch (err) { next(err); }
}

/** This month's invoice file — created as an ExpenseDocument through the expenses intake. */
async function attachInvoice(req, res, next) {
  try {
    const b = req.body || {};
    assertBranchInScope(req, b.branch_id);
    const out = await classPayments.attachInvoice({
      branch_id: b.branch_id,
      month: b.month,
      provider_id: b.provider_id || null,
      provider_name: b.provider_name || '',
      fields: b.fields && typeof b.fields === 'object' ? b.fields : {},
      file: b.file && typeof b.file === 'object' ? b.file : null,
      by: userId(req),
    });
    res.status(201).json(out);
  } catch (err) { next(err); }
}

module.exports = {
  listProviders, createProvider, updateProvider, deleteProvider,
  getProviderSchedule, setProviderSchedule, providerSettlement,
  listPrograms, createProgram, updateProgram, deleteProgram,
  listSessions, createSession, generateSessions, fillMonth, updateSession, deleteSession, closedDays,
  answerSession, answerVisit, dueSessions, paymentSummary,
  listPayments, markPayment, attachInvoice,
};
