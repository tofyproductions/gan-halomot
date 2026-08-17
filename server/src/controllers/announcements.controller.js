const { Announcement, Classroom } = require('../models');
const { resolveBranchScope, canAccessBranch } = require('../utils/branch-scope');
const { audienceFor, currentYear } = require('../services/announcement-audience.service');
const budgets = require('../services/smsBudget.service');
const cost = require('../services/smsCost.service');
const { sendSms } = require('../services/sms.service');

/**
 * What the gan tells the families, and who is allowed to say it.
 *
 * The chain is deliberate and it is two people. A teacher knows the trip is on
 * Thursday; a branch manager is accountable for what the gan says to two
 * hundred families. So a teacher writes and submits, and only a manager
 * publishes — and a manager writing her own does NOT route through her own
 * approval queue, because that is theatre and everybody learns to click
 * through it.
 *
 * Three ways out, and they make different promises:
 *
 *   the portal    — the truth, free, and where an announcement lives in full.
 *   WhatsApp      — a copy on the manager's clipboard. This system never talks
 *                   to WhatsApp and cannot know she pasted it, so it records
 *                   "copied" and never "sent".
 *   SMS           — really sent, really costs money, capped per branch per
 *                   month. See services/smsBudget.
 */

const DECIDERS = ['system_admin', 'branch_manager'];

function isDecider(user) {
  return DECIDERS.includes(user?.role);
}

/** The branch filter for a listing, from the user's real scope. */
async function scopeFilter(req) {
  const scope = await resolveBranchScope(req);
  return scope === null ? {} : { branch_id: { $in: scope } };
}

/**
 * The announcement at :id, if this user's branches include it.
 *
 * 404 rather than 403 for a branch they cannot see, so the id itself does not
 * confirm anything.
 */
async function loadInScope(req) {
  const doc = await Announcement.findById(req.params.id);
  if (!doc) return null;
  return (await canAccessBranch(req, doc.branch_id)) ? doc : null;
}

/** The shape the screens read. Never the raw document. */
function toJson(doc) {
  return {
    id: doc._id,
    branch_id: doc.branch_id,
    classroom_ids: doc.classroom_ids || [],
    academic_year: doc.academic_year,
    title: doc.title,
    body: doc.body,
    is_urgent: doc.is_urgent,
    status: doc.status,
    author_name: doc.author_name,
    author_role: doc.author_role,
    approved_by_name: doc.approved_by_name,
    approved_at: doc.approved_at,
    rejected_reason: doc.rejected_reason,
    published_at: doc.published_at,
    expires_at: doc.expires_at,
    created_at: doc.created_at,
    delivery: {
      whatsapp_copied_at: doc.delivery?.whatsapp_copied_at || null,
      sms_sent_at: doc.delivery?.sms_sent_at || null,
      sms_recipients: doc.delivery?.sms_recipients || 0,
      sms_failed: doc.delivery?.sms_failed || 0,
    },
  };
}

/**
 * GET /api/announcements?status=&branch=
 *
 * A teacher sees her own branch's, which is what resolveBranchScope already
 * gives her; she is not narrowed further to her own authorship, because
 * "what has the gan told the families" is a thing she needs to know before
 * telling them something contradictory.
 */
async function list(req, res, next) {
  try {
    const filter = await scopeFilter(req);
    if (req.query.status) filter.status = req.query.status;
    if (req.query.branch && req.query.branch !== 'all') {
      if (!(await canAccessBranch(req, req.query.branch))) {
        return res.status(403).json({ error: 'אין לך הרשאה לסניף זה' });
      }
      filter.branch_id = req.query.branch;
    }

    const docs = await Announcement.find(filter).sort({ created_at: -1 }).limit(200).lean();
    res.json({ announcements: docs.map(toJson) });
  } catch (e) { next(e); }
}

/**
 * POST /api/announcements
 *
 * A manager's own goes out; a teacher's waits. The status is decided here from
 * the role rather than accepted from the body — a client that asks for
 * 'published' is asking to skip the person the chain exists for.
 */
async function create(req, res, next) {
  try {
    const { branch_id, classroom_ids = [], title, body, is_urgent = false, expires_at = null } = req.body;

    if (!branch_id) return res.status(400).json({ error: 'לא נבחר סניף' });
    if (!(await canAccessBranch(req, branch_id))) {
      return res.status(403).json({ error: 'אין לך הרשאה לסניף זה' });
    }
    if (!String(title || '').trim()) return res.status(400).json({ error: 'חסרה כותרת' });
    if (!String(body || '').trim()) return res.status(400).json({ error: 'חסר תוכן' });

    // Rooms from another gan in the body must not widen the audience.
    const rooms = classroom_ids.length
      ? await Classroom.find({ _id: { $in: classroom_ids }, branch_id }).select('_id').lean()
      : [];

    const decider = isDecider(req.user);
    const doc = await Announcement.create({
      branch_id,
      classroom_ids: rooms.map(r => r._id),
      academic_year: currentYear(),
      title: String(title).trim().slice(0, 120),
      body: String(body).trim().slice(0, 2000),
      is_urgent: !!is_urgent,
      status: decider ? 'published' : 'pending',
      published_at: decider ? new Date() : null,
      approved_by: decider ? req.user.id : null,
      approved_by_name: decider ? (req.user.name || '') : '',
      approved_at: decider ? new Date() : null,
      author_id: req.user.id,
      author_name: req.user.name || '',
      author_role: req.user.role || '',
      expires_at: expires_at ? new Date(expires_at) : null,
    });

    res.status(201).json(toJson(doc));
  } catch (e) { next(e); }
}

/**
 * PATCH /api/announcements/:id
 *
 * Only before it is public, and a published one is not editable by anybody
 * here. Two hundred families have already read it; changing the text under
 * them means the version they were told and the version on record differ,
 * which is the one thing a written record is for. Rejected IS editable — that
 * is the point of keeping it.
 */
async function update(req, res, next) {
  try {
    const doc = await loadInScope(req);
    if (!doc) return res.status(404).json({ error: 'לא נמצא' });

    if (doc.status === 'published') {
      return res.status(409).json({ error: 'הודעה שפורסמה אינה ניתנת לעריכה. אפשר לפרסם הודעה חדשה.' });
    }
    const mine = String(doc.author_id) === String(req.user.id);
    if (!mine && !isDecider(req.user)) {
      return res.status(403).json({ error: 'אפשר לערוך רק הודעה שכתבת' });
    }

    if (req.body.title !== undefined) doc.title = String(req.body.title).trim().slice(0, 120);
    if (req.body.body !== undefined) doc.body = String(req.body.body).trim().slice(0, 2000);
    if (req.body.is_urgent !== undefined) doc.is_urgent = !!req.body.is_urgent;
    if (req.body.expires_at !== undefined) {
      doc.expires_at = req.body.expires_at ? new Date(req.body.expires_at) : null;
    }
    if (req.body.classroom_ids !== undefined) {
      const rooms = req.body.classroom_ids.length
        ? await Classroom.find({ _id: { $in: req.body.classroom_ids }, branch_id: doc.branch_id })
          .select('_id').lean()
        : [];
      doc.classroom_ids = rooms.map(r => r._id);
    }
    // An edited rejection goes back into the queue rather than staying
    // rejected with new text nobody has looked at.
    if (doc.status === 'rejected') {
      doc.status = 'pending';
      doc.rejected_reason = '';
    }

    await doc.save();
    res.json(toJson(doc));
  } catch (e) { next(e); }
}

/**
 * POST /api/announcements/:id/decide  { approve, reason }
 *
 * Rejecting REQUIRES a reason. A teacher told only "no" writes the same
 * announcement again, and the second rejection teaches her to stop writing
 * them at all.
 *
 * Guarded on the previous status, so a second press cannot re-publish
 * something already withdrawn or re-decide what somebody else just decided.
 */
async function decide(req, res, next) {
  try {
    const doc = await loadInScope(req);
    if (!doc) return res.status(404).json({ error: 'לא נמצא' });
    if (doc.status !== 'pending') {
      return res.status(409).json({ error: 'ההודעה כבר טופלה' });
    }

    const approve = !!req.body.approve;
    if (!approve && !String(req.body.reason || '').trim()) {
      return res.status(400).json({ error: 'יש לכתוב למה ההודעה נדחתה' });
    }

    doc.status = approve ? 'published' : 'rejected';
    doc.approved_by = req.user.id;
    doc.approved_by_name = req.user.name || '';
    doc.approved_at = new Date();
    doc.rejected_reason = approve ? '' : String(req.body.reason).trim().slice(0, 500);
    doc.published_at = approve ? new Date() : null;

    await doc.save();
    res.json(toJson(doc));
  } catch (e) { next(e); }
}

/**
 * GET /api/announcements/:id/audience
 *
 * Who it reaches, and what sending it as SMS would cost, BEFORE anybody
 * presses send. `unreachable` is families with no usable mobile on file —
 * the number that decides whether sending is enough on its own.
 */
async function audience(req, res, next) {
  try {
    const doc = await loadInScope(req);
    if (!doc) return res.status(404).json({ error: 'לא נמצא' });

    const aud = await audienceFor(doc.branch_id, doc.classroom_ids, doc.academic_year);
    const text = cost.urgentText(doc.title);
    const budget = await budgets.budgetFor(doc.branch_id);

    res.json({
      audience: {
        children: aud.children,
        families: aud.families,
        unreachable: aud.unreachable,
        classrooms: aud.classrooms,
      },
      sms: { text, ...cost.describe(text, aud.families) },
      budget,
    });
  } catch (e) { next(e); }
}

/**
 * POST /api/announcements/:id/whatsapp
 *
 * Hands back the text and records that somebody took it. It records COPIED,
 * not sent: nothing here reaches WhatsApp, the manager pastes it into the
 * group herself, and in six months "was the family told?" has to have an
 * honest answer.
 */
async function whatsappCopy(req, res, next) {
  try {
    const doc = await loadInScope(req);
    if (!doc) return res.status(404).json({ error: 'לא נמצא' });
    if (doc.status !== 'published') {
      return res.status(409).json({ error: 'אפשר להעתיק רק הודעה שפורסמה' });
    }

    doc.delivery.whatsapp_copied_at = new Date();
    doc.delivery.whatsapp_copied_by = req.user.id;
    await doc.save();

    res.json({
      text: `*${doc.title}*\n\n${doc.body}`,
      copied_at: doc.delivery.whatsapp_copied_at,
    });
  } catch (e) { next(e); }
}

/**
 * POST /api/announcements/:id/sms
 *
 * The only thing here that spends money.
 *
 * ALL OR NOTHING against the budget. Sending to as many families as the
 * allowance covers and stopping would be the worst possible outcome of an
 * urgent message: some families told, some not, and nobody able to say which.
 * If it does not fit, it is refused with the two numbers needed to decide what
 * to do — shorten the title, narrow it to one classroom, or ring the office
 * for more.
 *
 * The record is written from what actually happened, per number, so a partial
 * carrier failure is visible rather than averaged away.
 */
async function sendUrgentSms(req, res, next) {
  try {
    const doc = await loadInScope(req);
    if (!doc) return res.status(404).json({ error: 'לא נמצא' });
    if (doc.status !== 'published') {
      return res.status(409).json({ error: 'אפשר לשלוח רק הודעה שפורסמה' });
    }
    if (!doc.is_urgent) {
      return res.status(409).json({ error: 'ההודעה אינה מסומנת כדחופה' });
    }
    if (doc.delivery?.sms_sent_at) {
      return res.status(409).json({ error: 'ההודעה כבר נשלחה ב-SMS' });
    }

    const aud = await audienceFor(doc.branch_id, doc.classroom_ids, doc.academic_year);
    if (!aud.families) {
      return res.status(400).json({ error: 'אין מספרי טלפון תקינים בקבוצה הזו' });
    }

    const text = cost.urgentText(doc.title);
    const estimate = cost.describe(text, aud.families);
    if (estimate.over_limit) {
      return res.status(400).json({
        error: `הכותרת ארוכה מדי לשליחה (${estimate.segments} הודעות לכל משפחה). יש לקצר אותה.`,
      });
    }

    const budget = await budgets.budgetFor(doc.branch_id);
    if (estimate.messages > budget.remaining) {
      return res.status(409).json({
        error: 'המכסה החודשית לא מספיקה לשליחה הזו',
        code: 'BUDGET_EXCEEDED',
        needed: estimate.messages,
        remaining: budget.remaining,
        budget,
        estimate,
      });
    }

    let sent = 0;
    let failed = 0;
    for (const to of aud.phones) {
      try {
        await sendSms({ to, text });
        sent += 1;
      } catch {
        // One bad number is not a reason to abandon the rest, and the count is
        // what the record has to carry. The body is never logged.
        failed += 1;
      }
    }

    doc.delivery.sms_sent_at = new Date();
    doc.delivery.sms_sent_by = req.user.id;
    // Charged for what left, in segments — not in families.
    doc.delivery.sms_recipients = sent * estimate.segments;
    doc.delivery.sms_failed = failed;
    await doc.save();

    res.json({
      sent, failed,
      messages: sent * estimate.segments,
      budget: await budgets.budgetFor(doc.branch_id),
      announcement: toJson(doc),
    });
  } catch (e) { next(e); }
}

/** GET /api/announcements/budget?branch= */
async function budget(req, res, next) {
  try {
    const branchId = req.query.branch;
    if (!branchId) return res.status(400).json({ error: 'לא נבחר סניף' });
    if (!(await canAccessBranch(req, branchId))) {
      return res.status(403).json({ error: 'אין לך הרשאה לסניף זה' });
    }
    res.json(await budgets.budgetFor(branchId));
  } catch (e) { next(e); }
}

/**
 * POST /api/announcements/budget/grant  { branch_id, amount, reason }
 * system_admin only — the escape hatch is a person on purpose.
 */
async function grantBudget(req, res, next) {
  try {
    const { branch_id, amount, reason } = req.body;
    const n = Number(amount);
    if (!branch_id) return res.status(400).json({ error: 'לא נבחר סניף' });
    if (!Number.isFinite(n) || n <= 0) return res.status(400).json({ error: 'כמות לא תקינה' });
    if (!String(reason || '').trim()) return res.status(400).json({ error: 'יש לכתוב סיבה' });

    res.json(await budgets.grantExtra({
      branchId: branch_id, amount: Math.round(n), reason, userId: req.user.id,
    }));
  } catch (e) { next(e); }
}

/** DELETE /api/announcements/:id — only what was never public. */
async function remove(req, res, next) {
  try {
    const doc = await loadInScope(req);
    if (!doc) return res.status(404).json({ error: 'לא נמצא' });
    if (doc.status === 'published') {
      return res.status(409).json({ error: 'הודעה שפורסמה אינה נמחקת' });
    }
    const mine = String(doc.author_id) === String(req.user.id);
    if (!mine && !isDecider(req.user)) {
      return res.status(403).json({ error: 'אפשר למחוק רק הודעה שכתבת' });
    }
    await doc.deleteOne();
    res.json({ ok: true });
  } catch (e) { next(e); }
}

module.exports = {
  list, create, update, decide, audience,
  whatsappCopy, sendUrgentSms, budget, grantBudget, remove,
};
