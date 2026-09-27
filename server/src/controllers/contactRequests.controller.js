/**
 * "פניות למשרד" — staff ask the office; the routed office people answer in the
 * app (docs/superpowers/specs/2026-09-27-email-routing-and-contact-design.md).
 *
 *   POST /api/contact-requests                 new request (multipart: topic, text, file?)
 *   GET  /api/contact-requests/mine            the caller's own requests
 *   GET  /api/contact-requests/inbox?status=   requests in the caller's office topics
 *   GET  /api/contact-requests/counts          { open } for the menu badge
 *   GET  /api/contact-requests/:id             one thread
 *   POST /api/contact-requests/:id/reply       text + file?
 *   POST /api/contact-requests/:id/close
 *   GET  /api/contact-requests/:id/attachment/:i
 *
 * WHO SEES WHAT. The sender sees her own. An office person sees a topic when
 * the office routing puts them on it (officeUserIds) — so the developer does
 * not read salary questions. A topic nobody is routed to is shown to the
 * system admins, so a request can never sit where nobody can see it. A branch
 * manager gets nothing special: payroll questions live here.
 *
 * The role is read as `actual_role || role`: on a READ, a viewer's role is
 * swapped to system_admin (middleware/auth.js), and that swap must not hand
 * her the orphan-topic fallback.
 */
const mongoose = require('mongoose');
const { ContactRequest, User, Branch } = require('../models');
const R = require('../services/office-recipients.service');
const notificationService = require('../services/notification.service');
const { dispatchEmail } = require('../services/email.service');
const storage = require('../services/storage.service');

const CONTACT_TOPICS = R.TOPICS.filter(t => t.kind === 'contact');
const TOPIC_LABEL = Object.fromEntries(CONTACT_TOPICS.map(t => [t.key, t.label.replace(/^פנייה: /, '')]));
const MAX_TEXT = 2000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_INLINE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const realRole = (req) => req.user?.actual_role || req.user?.role;
const me = (req) => String(req.user?.id || '');

/** The contact topics this person reads as office. Pure over what it is given. */
function visibleTopicsFrom({ userId, role, routedByTopic }) {
  const out = new Set();
  for (const t of CONTACT_TOPICS) {
    const ids = routedByTopic[t.key] || [];
    if (ids.includes(String(userId))) out.add(t.key);
    else if (!ids.length && role === 'system_admin') out.add(t.key);
  }
  return out;
}

async function routedByTopic() {
  const entries = await Promise.all(CONTACT_TOPICS.map(async t => [t.key, await R.officeUserIds(t.key)]));
  return Object.fromEntries(entries);
}

async function visibleTopics(req) {
  return visibleTopicsFrom({ userId: me(req), role: realRole(req), routedByTopic: await routedByTopic() });
}

/** Who may do what with one thread: 'sender' | 'office' | null. */
function sideOf(doc, userId, topics) {
  if (String(doc.user_id) === String(userId)) return 'sender';
  if (topics.has(doc.topic)) return 'office';
  return null;
}

function cleanText(raw) {
  const text = String(raw || '').trim();
  if (!text) return { error: 'יש לכתוב את הפנייה' };
  if (text.length > MAX_TEXT) return { error: `הפנייה ארוכה מדי (עד ${MAX_TEXT} תווים)` };
  return { text };
}

/** The uploaded screenshot → an attachment, or an error in Hebrew. */
async function takeFile(file) {
  if (!file) return { attachment: null };
  if (!IMAGE_TYPES.has(file.mimetype)) {
    return { error: 'אפשר לצרף רק תמונה (צילום מסך) — JPG, PNG או WEBP' };
  }
  if (file.size > MAX_FILE_BYTES) return { error: 'התמונה גדולה מדי (עד 10MB)' };
  const name = String(file.originalname || 'screenshot').slice(0, 120);
  if (storage.isConfigured()) {
    const ext = file.mimetype.split('/')[1].replace('jpeg', 'jpg');
    const key = storage.makeKey('contact-requests', ext);
    await storage.putObject({ key, body: file.buffer, contentType: file.mimetype });
    return { attachment: { storage_key: key, data: null, content_type: file.mimetype, name } };
  }
  if (file.size > MAX_INLINE_BYTES) return { error: 'התמונה גדולה מדי (עד 5MB)' };
  return { attachment: { storage_key: null, data: file.buffer.toString('base64'), content_type: file.mimetype, name } };
}

/** A thread for the wire — attachments reduced to "there is one". */
function out(doc, side) {
  return {
    id: String(doc._id),
    topic: doc.topic,
    topic_label: TOPIC_LABEL[doc.topic] || doc.topic,
    status: doc.status,
    user_name: doc.user_name,
    branch_name: doc.branch_name || null,
    created_at: doc.created_at,
    last_message_at: doc.last_message_at,
    side,
    messages: (doc.messages || []).map((m, i) => ({
      i, at: m.at, by_name: m.by_name, from_office: !!m.from_office, text: m.text,
      has_attachment: !!(m.attachment && (m.attachment.storage_key || m.attachment.data)),
      mine: String(m.by) === String(doc.viewer_id),
    })),
  };
}

async function withBranchNames(docs) {
  const ids = [...new Set(docs.map(d => d.branch_id && String(d.branch_id)).filter(Boolean))];
  const names = new Map((await Branch.find({ _id: { $in: ids } }).select('name').lean()).map(b => [String(b._id), b.name]));
  return docs.map(d => ({ ...d, branch_name: d.branch_id ? names.get(String(d.branch_id)) || null : null }));
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Tell the routed office: email (with the system-admin fallback) + a push that repeats until answered. */
async function tellOffice(doc, { isReply }) {
  const label = TOPIC_LABEL[doc.topic];
  const last = doc.messages[doc.messages.length - 1];
  const base = (process.env.CLIENT_URL || '').replace(/\/$/, '');
  try {
    const to = await R.officeEmails(doc.topic);
    if (to.length) {
      await dispatchEmail({
        to: to.join(','),
        subject: `${isReply ? 'תגובה בפנייה' : 'פנייה חדשה'} — ${label} — ${doc.user_name}`,
        html: `<div dir="rtl" style="font-family:Arial,sans-serif">
          <p><b>${esc(doc.user_name)}</b>${doc.branch_name ? ` · ${esc(doc.branch_name)}` : ''} · ${esc(label)}</p>
          <p style="white-space:pre-wrap">${esc(last?.text)}</p>
          ${last?.attachment ? '<p>📎 צורפה תמונה — אפשר לראות אותה במערכת.</p>' : ''}
          ${base ? `<p><a href="${base}/contact-inbox">לפתיחת הפנייה במערכת</a></p>` : ''}
        </div>`,
        text: `${doc.user_name} — ${label}\n\n${last?.text || ''}`,
      });
    }
  } catch (err) { console.error('[contact] office email failed:', err.message); }

  try {
    let ids = await R.officeUserIds(doc.topic);
    if (!ids.length) {
      ids = (await User.find({ role: 'system_admin', is_active: { $ne: false }, is_test_account: { $ne: true } })
        .select('_id').lean()).map(u => String(u._id));
    }
    await Promise.all(ids.filter(id => id !== String(doc.user_id)).map(recipient_id => notificationService.createEvent({
      type: 'contact_request_new', ref_collection: 'ContactRequest', ref_id: doc._id, recipient_id,
      title: `${isReply ? 'תגובה בפנייה' : 'פנייה חדשה'} — ${label}`,
      body: `${doc.user_name}: ${String(last?.text || '').slice(0, 80)}`,
      url: '/contact-inbox',
    })));
  } catch (err) { console.error('[contact] office push failed:', err.message); }
}

/** POST / */
async function create(req, res, next) {
  try {
    const topic = String(req.body?.topic || '');
    if (!TOPIC_LABEL[topic]) return res.status(400).json({ error: 'יש לבחור נושא' });
    const t = cleanText(req.body?.text);
    if (t.error) return res.status(400).json({ error: t.error });
    const f = await takeFile(req.file);
    if (f.error) return res.status(400).json({ error: f.error });

    let emp = null;
    try { emp = await require('./payroll.controller').resolveSelfEmployee(req); } catch { emp = null; }
    const doc = await ContactRequest.create({
      user_id: me(req),
      user_name: req.user?.full_name || emp?.full_name || '',
      employee_id: emp?._id || null,
      branch_id: emp?.branch_id || req.user?.branch_id || null,
      topic,
      status: 'open',
      messages: [{ by: me(req), by_name: req.user?.full_name || '', from_office: false, text: t.text, attachment: f.attachment }],
      last_message_at: new Date(),
    });
    const [withName] = await withBranchNames([doc.toObject()]);
    tellOffice(withName, { isReply: false });
    res.status(201).json(out({ ...withName, viewer_id: me(req) }, 'sender'));
  } catch (err) { next(err); }
}

/** GET /mine */
async function mine(req, res, next) {
  try {
    const docs = await ContactRequest.find({ user_id: me(req) })
      .select('-messages.attachment.data').sort({ last_message_at: -1 }).limit(100).lean();
    res.json({ requests: (await withBranchNames(docs)).map(d => out({ ...d, viewer_id: me(req) }, 'sender')) });
  } catch (err) { next(err); }
}

const STATUSES = new Set(['open', 'answered', 'closed']);

/** GET /inbox?status=open|answered|closed|all */
async function inbox(req, res, next) {
  try {
    const topics = [...await visibleTopics(req)];
    if (!topics.length) return res.json({ requests: [], topics: [] });
    const status = String(req.query.status || 'open');
    const filter = { topic: { $in: topics } };
    if (STATUSES.has(status)) filter.status = status;
    const docs = await ContactRequest.find(filter)
      .select('-messages.attachment.data').sort({ last_message_at: -1 }).limit(200).lean();
    res.json({
      topics: topics.map(k => ({ key: k, label: TOPIC_LABEL[k] })),
      requests: (await withBranchNames(docs)).map(d => out({ ...d, viewer_id: me(req) }, String(d.user_id) === me(req) ? 'sender' : 'office')),
    });
  } catch (err) { next(err); }
}

/** GET /counts */
async function counts(req, res, next) {
  try {
    const topics = [...await visibleTopics(req)];
    const open = topics.length
      ? await ContactRequest.countDocuments({ topic: { $in: topics }, status: 'open', user_id: { $ne: me(req) } })
      : 0;
    res.json({ open });
  } catch (err) { next(err); }
}

async function loadThread(req, res, { withData = false } = {}) {
  const id = String(req.params.id || '');
  if (!mongoose.isValidObjectId(id)) { res.status(404).json({ error: 'הפנייה לא נמצאה' }); return null; }
  const q = ContactRequest.findById(id);
  if (!withData) q.select('-messages.attachment.data');
  const doc = await q;
  if (!doc) { res.status(404).json({ error: 'הפנייה לא נמצאה' }); return null; }
  const side = sideOf(doc, me(req), await visibleTopics(req));
  if (!side) { res.status(404).json({ error: 'הפנייה לא נמצאה' }); return null; }
  return { doc, side };
}

/** GET /:id */
async function getOne(req, res, next) {
  try {
    const t = await loadThread(req, res);
    if (!t) return;
    const [d] = await withBranchNames([t.doc.toObject()]);
    res.json(out({ ...d, viewer_id: me(req) }, t.side));
  } catch (err) { next(err); }
}

/** POST /:id/reply */
async function reply(req, res, next) {
  try {
    // Loaded WITH the attachment bytes: pushing a message rewrites the whole
    // array on save, and a projected-away field would be written back empty.
    const t = await loadThread(req, res, { withData: true });
    if (!t) return;
    const { doc, side } = t;
    if (doc.status === 'closed') return res.status(409).json({ error: 'הפנייה סגורה — אפשר לפתוח פנייה חדשה' });
    const txt = cleanText(req.body?.text);
    if (txt.error) return res.status(400).json({ error: txt.error });
    const f = await takeFile(req.file);
    if (f.error) return res.status(400).json({ error: f.error });

    const fromOffice = side === 'office';
    doc.messages.push({ by: me(req), by_name: req.user?.full_name || '', from_office: fromOffice, text: txt.text, attachment: f.attachment });
    doc.status = fromOffice ? 'answered' : 'open';
    doc.last_message_at = new Date();
    await doc.save();
    const [d] = await withBranchNames([doc.toObject()]);

    if (fromOffice) {
      await notificationService.resolveEvents({ ref_collection: 'ContactRequest', ref_id: doc._id });
      notificationService.notifyOnce({
        type: 'contact_request_reply', ref_collection: 'ContactRequest', ref_id: doc._id, recipient_id: doc.user_id,
        title: `התקבלה תשובה לפנייה שלך — ${TOPIC_LABEL[doc.topic]}`,
        body: `${req.user?.full_name || 'המשרד'}: ${txt.text.slice(0, 80)}`,
        url: '/contact-office',
      }).catch(err => console.error('[contact] reply push failed:', err.message));
    } else {
      tellOffice(d, { isReply: true });
    }
    res.json(out({ ...d, viewer_id: me(req) }, side));
  } catch (err) { next(err); }
}

/** POST /:id/close */
async function close(req, res, next) {
  try {
    const t = await loadThread(req, res, { withData: true });
    if (!t) return;
    const { doc, side } = t;
    if (doc.status !== 'closed') {
      doc.status = 'closed';
      doc.closed_at = new Date();
      doc.closed_by = me(req);
      await doc.save();
      await notificationService.resolveEvents({ ref_collection: 'ContactRequest', ref_id: doc._id });
    }
    const [d] = await withBranchNames([doc.toObject()]);
    res.json(out({ ...d, viewer_id: me(req) }, side));
  } catch (err) { next(err); }
}

/** GET /:id/attachment/:i — the bytes, behind the same visibility. */
async function attachment(req, res, next) {
  try {
    const t = await loadThread(req, res, { withData: true });
    if (!t) return;
    const m = t.doc.messages[Number(req.params.i)];
    const a = m?.attachment;
    if (!a || (!a.storage_key && !a.data)) return res.status(404).json({ error: 'אין קובץ מצורף' });
    const bytes = a.storage_key ? await storage.getObject(a.storage_key) : Buffer.from(a.data, 'base64');
    res.set('Content-Type', a.content_type || 'application/octet-stream');
    res.set('Cache-Control', 'private, max-age=300');
    res.send(bytes);
  } catch (err) { next(err); }
}

module.exports = {
  create, mine, inbox, counts, getOne, reply, close, attachment,
  MAX_FILE_BYTES,
  _internals: { visibleTopicsFrom, sideOf, cleanText, TOPIC_LABEL },
};
