const { ClassProvider, ClassProgram, ClassSession, Classroom } = require('../models');

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
    const { name, field, phone, email, notes } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'שם ספק נדרש' });
    const provider = await ClassProvider.create({
      name: String(name).trim(), field: field || '', phone: phone || '', email: email || '', notes: notes || '',
    });
    res.status(201).json({ provider });
  } catch (err) { next(err); }
}
async function updateProvider(req, res, next) {
  try {
    const fields = ['name', 'field', 'phone', 'email', 'notes', 'is_active'];
    const update = {};
    for (const f of fields) if (req.body[f] !== undefined) update[f] = req.body[f];
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

// ========================= Programs (חוגים) =========================
async function listPrograms(req, res, next) {
  try {
    const filter = {};
    if (req.query.branch && req.query.branch !== 'all') filter.branch_id = req.query.branch;
    if (req.query.active === 'true') filter.is_active = true;
    const programs = await ClassProgram.find(filter)
      .populate('provider_id', 'name phone field')
      .sort({ name: 1 }).lean();
    res.json({ programs });
  } catch (err) { next(err); }
}
async function createProgram(req, res, next) {
  try {
    const b = req.body || {};
    if (!b.branch_id || !b.name) return res.status(400).json({ error: 'סניף ושם חוג נדרשים' });
    const program = await ClassProgram.create({
      branch_id: b.branch_id,
      provider_id: b.provider_id || null,
      name: String(b.name).trim(),
      instructor_name: b.instructor_name || '',
      classroom_category: b.classroom_category || '',
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
    const fields = ['provider_id', 'name', 'instructor_name', 'classroom_category', 'classroom_id',
      'default_rate', 'default_day', 'default_time', 'color', 'is_active'];
    const update = {};
    for (const f of fields) if (req.body[f] !== undefined) update[f] = req.body[f];
    if (update.default_day === '' ) update.default_day = null;
    const program = await ClassProgram.findByIdAndUpdate(req.params.id, update, { new: true }).lean();
    if (!program) return res.status(404).json({ error: 'חוג לא נמצא' });
    res.json({ program });
  } catch (err) { next(err); }
}
async function deleteProgram(req, res, next) {
  try {
    await ClassProgram.findByIdAndUpdate(req.params.id, { is_active: false });
    res.json({ ok: true });
  } catch (err) { next(err); }
}

// ========================= Sessions =========================
// GET /classes/sessions?branch=&month=YYYY-MM  OR  ?program_id=
async function listSessions(req, res, next) {
  try {
    const filter = {};
    if (req.query.program_id) filter.program_id = req.query.program_id;
    if (req.query.branch && req.query.branch !== 'all') filter.branch_id = req.query.branch;
    if (req.query.month) filter.date = { $regex: `^${req.query.month}` };
    const sessions = await ClassSession.find(filter)
      .populate('program_id', 'name instructor_name color default_rate provider_id classroom_category')
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

async function updateSession(req, res, next) {
  try {
    const fields = ['date', 'time', 'rate', 'classroom_id'];
    const update = {};
    for (const f of fields) if (req.body[f] !== undefined) update[f] = req.body[f];
    const session = await ClassSession.findByIdAndUpdate(req.params.id, update, { new: true }).lean();
    if (!session) return res.status(404).json({ error: 'מפגש לא נמצא' });
    res.json({ session });
  } catch (err) { next(err); }
}

async function deleteSession(req, res, next) {
  try {
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
function isManagerRole(req) {
  return ['system_admin', 'branch_manager', 'accountant'].includes(req.user?.role);
}

/**
 * POST /classes/sessions/:id/answer
 * Body: { arrived: bool, reason?, reschedule?: bool, new_date? }
 * Records the popup answer. The branch manager's confirmation is always
 * required; if only the class lead answers, manager_confirmed stays false.
 * A reschedule creates a NEW scheduled session and marks this one 'postponed'
 * (never counted for payment).
 */
async function answerSession(req, res, next) {
  try {
    const session = await ClassSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: 'מפגש לא נמצא' });

    const manager = isManagerRole(req);
    const lead = await isClassLead(req, session);
    if (!manager && !lead) return res.status(403).json({ error: 'אין הרשאה לענות על מפגש זה' });

    const { arrived, reason, reschedule, new_date } = req.body || {};
    if (manager) session.answered_by_manager = true;
    if (lead) session.answered_by_lead = true;
    session.responder_id = req.user?.id || null;
    session.responded_at = new Date();
    // The manager's confirmation gate — set once a manager (or admin) answers.
    if (manager) session.manager_confirmed = true;

    if (arrived) {
      session.status = 'occurred';
      session.no_show_reason = '';
    } else if (reschedule && new_date) {
      // Create the replacement session, then mark this one postponed.
      const replacement = await ClassSession.create({
        program_id: session.program_id,
        branch_id: session.branch_id,
        classroom_id: session.classroom_id,
        date: new_date,
        time: session.time,
        rate: session.rate,
        status: 'scheduled',
        postponed_from_session_id: session._id,
      });
      session.status = 'postponed';
      session.postponed_to_date = new_date;
      session.postponed_to_session_id = replacement._id;
      session.no_show_reason = reason || '';
    } else {
      session.status = 'no_show';
      session.no_show_reason = reason || '';
    }
    await session.save();
    res.json({ session });
  } catch (err) { next(err); }
}

/**
 * GET /classes/sessions/due
 * Sessions whose date+time have arrived and that still need this user's answer,
 * for the occurrence popup poller. Managers see their branches' sessions; class
 * leads see their classrooms'. A manager still sees a lead-answered session
 * until the manager confirms it (manager_confirmed=false).
 */
async function dueSessions(req, res, next) {
  try {
    const { ymd, hhmm } = israelNow();
    // Base: not resolved to a terminal, and due by now.
    const base = {
      status: 'scheduled',
      $or: [{ date: { $lt: ymd } }, { date: ymd, time: { $lte: hhmm } }, { date: ymd, time: '' }],
    };

    const manager = isManagerRole(req);
    let sessions = [];
    if (manager) {
      const scope = managedBranchIds(req);
      const filter = { ...base };
      if (scope) filter.branch_id = { $in: scope };
      // A manager needs to answer sessions not yet manager-confirmed.
      filter.manager_confirmed = { $ne: true };
      sessions = await ClassSession.find(filter)
        .populate('program_id', 'name instructor_name').lean();
    } else {
      // Class lead: sessions of classrooms they lead.
      const rooms = await Classroom.find({ lead_teacher_id: req.user?.id }).select('_id').lean();
      const roomIds = rooms.map(r => r._id);
      if (roomIds.length) {
        const filter = { ...base, classroom_id: { $in: roomIds }, answered_by_lead: { $ne: true } };
        sessions = await ClassSession.find(filter)
          .populate('program_id', 'name instructor_name').lean();
      }
    }
    res.json({
      sessions: sessions.map(s => ({
        id: String(s._id),
        program_name: s.program_id?.name || 'חוג',
        instructor: s.program_id?.instructor_name || '',
        date: s.date, time: s.time || '',
      })),
    });
  } catch (err) { next(err); }
}

/**
 * GET /classes/payment-summary?branch=&month=YYYY-MM
 * Per-program payment for the month = Σ occurred sessions × rate. Postponed and
 * no-show sessions contribute nothing (no double pay).
 */
async function paymentSummary(req, res, next) {
  try {
    const filter = {};
    if (req.query.branch && req.query.branch !== 'all') filter.branch_id = req.query.branch;
    if (req.query.month) filter.date = { $regex: `^${req.query.month}` };
    const sessions = await ClassSession.find(filter)
      .populate('program_id', 'name instructor_name provider_id').lean();
    const byProgram = new Map();
    for (const s of sessions) {
      const key = String(s.program_id?._id || s.program_id);
      if (!byProgram.has(key)) {
        byProgram.set(key, {
          program_id: key,
          program_name: s.program_id?.name || 'חוג',
          instructor: s.program_id?.instructor_name || '',
          occurred: 0, scheduled: 0, no_show: 0, postponed: 0, total_pay: 0,
        });
      }
      const row = byProgram.get(key);
      row[s.status] = (row[s.status] || 0) + 1;
      if (s.status === 'occurred') row.total_pay += Number(s.rate) || 0;
    }
    res.json({ summary: [...byProgram.values()] });
  } catch (err) { next(err); }
}

module.exports = {
  listProviders, createProvider, updateProvider, deleteProvider,
  listPrograms, createProgram, updateProgram, deleteProgram,
  listSessions, createSession, generateSessions, updateSession, deleteSession,
  answerSession, dueSessions, paymentSummary,
};
