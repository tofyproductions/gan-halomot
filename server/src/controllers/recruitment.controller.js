const { Candidate, Branch } = require('../models');
const { resolveBranchScope } = require('../utils/branch-scope');
const recruitment = require('../services/recruitment.service');

/**
 * גיוס עובדים — the queue between somebody asking for work and a manager
 * picking up the phone.
 *
 * Every read here is scoped in the SERVER, from the user's record, never from
 * a query parameter. These rows are private phone numbers of people who do not
 * work here and never agreed to be seen by four gans; `?branch=all` must not
 * be a way in. The rest of this system filters on the parameter alone and that
 * is being fixed separately — this screen does not wait for it.
 */

/** Two days after the first missed call, one after the second, then archive. */
const RETRY_DAYS = [2, 1];
/** A candidate nobody has touched for this long is the office's problem. */
const STALE_HOURS = 48;

const plusDays = (n, from = new Date()) => new Date(from.getTime() + n * 86400000);

/** Israeli mobile → intl for wa.me (0501234567 → 972501234567). */
const waNumber = (phone) => {
  const d = String(phone || '').replace(/\D/g, '');
  return d.startsWith('0') ? `972${d.slice(1)}` : d;
};

const fmtWhen = (d) => (d
  ? new Date(d).toLocaleString('he-IL', { weekday: 'long', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })
  : '');

/**
 * The message the manager will send — built here, sent by her.
 *
 * A wa.me link opens WhatsApp with the text ready and she presses send, the
 * same as everywhere else in this system. Nothing is delivered automatically:
 * an automated first message to somebody who never wrote to us needs a paid
 * provider and templates approved by Meta, and it is not what was asked for.
 */
function interviewWhatsapp(candidate, branchName) {
  if (!candidate.phone) return null;
  const lines = [
    `שלום ${candidate.full_name},`,
    `תודה על פנייתך לגן החלומות${branchName ? ` — סניף ${branchName}` : ''}.`,
    `נקבע לך ראיון עבודה ל${fmtWhen(candidate.interview?.at)}.`,
  ];
  if (candidate.interview?.note) lines.push('', candidate.interview.note);
  lines.push('', 'נשמח לראותך!');
  return `https://wa.me/${waNumber(candidate.phone_raw || candidate.phone)}?text=${encodeURIComponent(lines.join('\n'))}`;
}

/**
 * The branch filter for this caller, from the database.
 *
 * null scope (system_admin, accountant) sees everything, INCLUDING the ones
 * that resolved to no branch — those are the office's to route, and the office
 * is exactly who has a null scope.
 */
async function scopeFilter(req) {
  const scope = await resolveBranchScope(req);
  if (scope === null) return {};
  return { branch_ids: { $in: scope } };
}

function shape(c, branchNames) {
  const names = (c.branch_ids || []).map(id => branchNames.get(String(id))).filter(Boolean);
  return {
    id: c._id,
    full_name: c.full_name,
    phone: c.phone_raw || c.phone,
    requested_branch: c.requested_branch,
    branch_names: names,
    branch_unmatched: c.branch_unmatched,
    for_office: !(c.branch_ids || []).length,
    status: c.status,
    next_action_at: c.next_action_at,
    applied_at: c.applications?.[c.applications.length - 1]?.at || c.created_at,
    application_count: (c.applications || []).length,
    attempt_count: (c.attempts || []).length,
    interview: c.interview?.at ? { at: c.interview.at, note: c.interview.note } : null,
    close_reason: c.close_reason,
    future_relevant: c.future_relevant,
    message: c.applications?.[c.applications.length - 1]?.message || '',
    // Only the earlier ones — the current application is the row itself.
    history: (c.applications || []).slice(0, -1).map(a => ({ at: a.at, branch: a.requested_branch })),
    events: (c.events || []).map(e => ({ at: e.at, type: e.type, note: e.note, by: e.by_name })),
    whatsapp_url: c.interview?.at ? interviewWhatsapp(c, names[0] || '') : null,
    hours_waiting: c.status === 'new'
      ? Math.floor((Date.now() - new Date(c.next_action_at).getTime()) / 3600000)
      : null,
  };
}

/**
 * GET /api/recruitment?view=due|scheduled|archived|all
 *
 * `due` is the working screen and is deliberately one query: everything whose
 * next_action_at has arrived, whether that is a new applicant, a callback two
 * days after a missed call, or somebody a manager parked until March. The
 * three are the same job — call this person today — and separating them into
 * three lists would only ask the manager to check three places.
 */
async function list(req, res, next) {
  try {
    const view = req.query.view || 'due';
    const filter = await scopeFilter(req);

    if (view === 'due') {
      Object.assign(filter, {
        status: { $in: ['new', 'no_answer', 'not_relevant'] },
        next_action_at: { $lte: new Date() },
      });
    } else if (view === 'scheduled') {
      Object.assign(filter, { status: 'interview_scheduled' });
    } else if (view === 'archived') {
      Object.assign(filter, { status: 'archived' });
    }

    if (req.query.q) {
      const q = String(req.query.q).trim();
      const digits = q.replace(/\D/g, '');
      filter.$or = [
        { full_name: { $regex: q, $options: 'i' } },
        ...(digits ? [{ phone: { $regex: digits } }] : []),
      ];
      // A search is a search: it looks through everything this caller may see,
      // which is the whole point of keeping archived people rather than
      // deleting them — somebody rings back and the office types the number.
      delete filter.status;
      delete filter.next_action_at;
    }

    const rows = await Candidate.find(filter)
      .sort(view === 'scheduled' ? { 'interview.at': 1 } : { next_action_at: 1 })
      .limit(500)
      .lean();

    const branches = await Branch.find({}).select('name').lean();
    const branchNames = new Map(branches.map(b => [String(b._id), b.name]));
    res.json({ candidates: rows.map(c => shape(c, branchNames)) });
  } catch (error) {
    next(error);
  }
}

/** GET /api/recruitment/counts — the tab badges, in one round trip. */
async function counts(req, res, next) {
  try {
    const base = await scopeFilter(req);
    const now = new Date();
    const [due, scheduled, archived, stale] = await Promise.all([
      Candidate.countDocuments({ ...base, status: { $in: ['new', 'no_answer', 'not_relevant'] }, next_action_at: { $lte: now } }),
      Candidate.countDocuments({ ...base, status: 'interview_scheduled' }),
      Candidate.countDocuments({ ...base, status: 'archived' }),
      Candidate.countDocuments({
        ...base,
        status: 'new',
        next_action_at: { $lte: new Date(now.getTime() - STALE_HOURS * 3600000) },
      }),
    ]);
    res.json({ due, scheduled, archived, stale, stale_hours: STALE_HOURS });
  } catch (error) {
    next(error);
  }
}

/** POST /api/recruitment/pull — fetch from mail-sorter now, without waiting. */
async function pull(req, res, next) {
  try {
    const result = await recruitment.pullFromMailSorter();
    if (!result.configured) {
      return res.status(503).json({ error: 'mail-sorter לא מוגדר — חסרים MAIL_SORTER_URL / MAIL_SORTER_TOKEN' });
    }
    res.json({
      ...result,
      summary: `נבדקו ${result.seen} פריטים · ${result.created} מועמדים חדשים · ${result.reopened} חזרו לרשימה`
        + (result.files ? ` · ${result.files} קבצים ללא שדות (קורות חיים)` : ''),
    });
  } catch (error) {
    next(error);
  }
}

/** The candidate, if this caller may act on them. */
async function loadScoped(req, id) {
  const doc = await Candidate.findById(id);
  if (!doc) return { error: 'מועמד/ת לא נמצא/ה', status: 404 };
  const scope = await resolveBranchScope(req);
  if (scope !== null) {
    const allowed = (doc.branch_ids || []).some(b => scope.includes(String(b)));
    if (!allowed) return { error: 'אין לך הרשאה למועמד/ת הזה/הזאת', status: 403 };
  }
  return { doc };
}

const actor = req => ({ by: req.user?.id || null, by_name: req.user?.full_name || req.user?.username || '' });

/** POST /api/recruitment/:id/interview  { at, note } */
async function scheduleInterview(req, res, next) {
  try {
    const { doc, error, status } = await loadScoped(req, req.params.id);
    if (error) return res.status(status).json({ error });

    const at = new Date(req.body?.at);
    if (Number.isNaN(at.getTime())) return res.status(400).json({ error: 'יש להזין תאריך ושעה לראיון' });

    const now = new Date();
    doc.status = 'interview_scheduled';
    doc.interview = {
      at,
      note: String(req.body?.note || ''),
      scheduled_by: req.user?.id || null,
      scheduled_at: now,
    };
    // It is no longer waiting for a call — the date on the calendar is what
    // brings it back, not the queue.
    doc.next_action_at = at;
    doc.attempts = [];
    doc.events.push({ at: now, ...actor(req), type: 'interview_scheduled', note: fmtWhen(at) });
    doc.retain_until = recruitment.retentionFrom(now, doc.retain_until);
    await doc.save();

    const branches = await Branch.find({ _id: { $in: doc.branch_ids } }).select('name').lean();
    res.json({
      ok: true,
      whatsapp_url: interviewWhatsapp(doc, branches[0]?.name || ''),
    });
  } catch (error) {
    next(error);
  }
}

/** POST /api/recruitment/:id/not-relevant  { reason, future_relevant, callback_at } */
async function markNotRelevant(req, res, next) {
  try {
    const { doc, error, status } = await loadScoped(req, req.params.id);
    if (error) return res.status(status).json({ error });

    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'יש לכתוב סיבה — היא מה שיישאר לפעם הבאה' });

    const now = new Date();
    const future = !!req.body?.future_relevant;
    const callback = future && req.body?.callback_at ? new Date(req.body.callback_at) : null;
    if (future && (!callback || Number.isNaN(callback.getTime()))) {
      return res.status(400).json({ error: 'סומן "רלוונטי לעתיד" — יש להזין תאריך לשיחה חוזרת' });
    }

    doc.status = 'not_relevant';
    doc.close_reason = reason;
    doc.future_relevant = future;
    // No callback date means nothing brings them back on its own. Far-future
    // rather than null so the one "when is this due" query keeps working.
    doc.next_action_at = callback || new Date('2999-01-01');
    doc.events.push({ at: now, ...actor(req), type: 'not_relevant', note: reason });
    doc.retain_until = recruitment.retentionFrom(now, callback);
    await doc.save();
    res.json({ ok: true, callback_at: callback });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/recruitment/:id/no-answer
 *
 * Two days, then one, then off the screen. Archived and not deleted: somebody
 * who missed three calls across four days may have been at work, and if they
 * ring back the office types their number and finds them.
 */
async function markNoAnswer(req, res, next) {
  try {
    const { doc, error, status } = await loadScoped(req, req.params.id);
    if (error) return res.status(status).json({ error });

    const now = new Date();
    doc.attempts.push({ at: now, by: req.user?.id || null, outcome: 'no_answer' });
    const n = doc.attempts.length;

    if (n > RETRY_DAYS.length) {
      doc.status = 'archived';
      doc.next_action_at = new Date('2999-01-01');
      doc.events.push({ at: now, ...actor(req), type: 'archived', note: `${n} ניסיונות ללא מענה` });
    } else {
      doc.status = 'no_answer';
      doc.next_action_at = plusDays(RETRY_DAYS[n - 1], now);
      doc.events.push({
        at: now, ...actor(req), type: 'no_answer',
        note: `ניסיון ${n} — לחזור ב־${doc.next_action_at.toLocaleDateString('he-IL')}`,
      });
    }
    doc.retain_until = recruitment.retentionFrom(now, doc.retain_until);
    await doc.save();
    res.json({ ok: true, status: doc.status, attempts: n, next_action_at: doc.next_action_at });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  list, counts, pull, scheduleInterview, markNotRelevant, markNoAnswer,
  STALE_HOURS, RETRY_DAYS, interviewWhatsapp,
};
