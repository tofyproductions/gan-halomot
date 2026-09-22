const { Branch, Candidate, User } = require('../models');
const recruitment = require('../services/recruitment.service');
const storage = require('../services/storage.service');
const { dispatchEmail } = require('../services/email.service');
const notificationService = require('../services/notification.service');
const { branchManagerFilter } = require('../services/branch-recipients.service');

/**
 * דרושים — the public hiring page, and the form at the bottom of it.
 *
 * Until now an application went: a static page on GitHub Pages → a Google
 * Apps Script → an email → mail-sorter → a pull somebody had to remember to
 * press. Five hops, each of which can be down without anybody noticing, for a
 * person who typed their phone number and expects a call. A Facebook campaign
 * pointed at that chain is paying for applications that sit in a mailbox.
 *
 * So the form posts HERE, and the candidate exists in the same request. The
 * mail-sorter path stays exactly as it was — it is how applications from
 * anywhere else still arrive, and `source` is what tells them apart.
 *
 * ANONYMOUS AND ADVERTISED. This is the only write endpoint in the system that
 * a paid campaign sends strangers to, so everything below assumes the caller
 * is hostile until proven boring: the payload is bounded field by field, the
 * branch is resolved from OUR list rather than trusted, the CV is size- and
 * type-checked before a byte is stored, and the route is rate limited at the
 * mount point. Nothing here reads a role, because there is nobody to ask.
 */

/** A CV is a document. Anything else is somebody testing what we accept. */
const CV_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg', 'image/png', 'image/heic', 'image/heif',
]);
const MAX_CV_BYTES = 8 * 1024 * 1024;

const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

/**
 * GET /api/public/careers/branches
 *
 * The dropdown. Built from the real branch list rather than hard-coded,
 * because a branch that opens next year must appear here without a deploy —
 * and a page that offers a gan we do not run is worse than one that offers
 * fewer.
 *
 * The office is appended as a deliberate non-branch: "I have not decided" is a
 * real answer, and forcing a choice makes people pick one at random, which
 * routes them to a manager with no reason to expect them.
 */
async function publicBranches(req, res, next) {
  try {
    const branches = await Branch.find({ is_active: { $ne: false } })
      .select('name').sort({ name: 1 }).lean();

    // The applicant picks a PLACE, not a row in our database. כפר סבא is two
    // branches under one manager, and offering both by their internal names
    // asks a stranger a question about our filing. The label is what is sent
    // back, and services/recruitment.service#resolveBranches turns it into
    // whichever branches it means.
    const labels = [...new Set(branches.map(b => String(b.name).split(' - ')[0].trim()))]
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, 'he'));

    res.json({
      branches: labels.map(name => ({ value: name, label: `סניף ${name}` })),
      office: { value: 'משרד', label: 'לא סגור/ה — מענה כללי' },
    });
  } catch (err) { next(err); }
}

/** Where the CV goes. Returns the `cv` sub-document, or null. */
async function storeCv(part) {
  if (!part) return null;
  if (!CV_TYPES.has(part.mimetype)) {
    throw Object.assign(new Error('אפשר לצרף קובץ PDF, Word או תמונה בלבד'), { status: 400 });
  }
  if (part.size > MAX_CV_BYTES) {
    throw Object.assign(new Error('הקובץ גדול מדי — עד 8MB'), { status: 413 });
  }
  const cv = {
    filename: clean(part.originalname, 160) || 'קורות חיים',
    mimetype: part.mimetype,
    size_bytes: part.size,
    uploaded_at: new Date(),
    storage_key: null,
    data: null,
  };
  if (storage.isConfigured()) {
    const ext = (cv.filename.split('.').pop() || 'pdf').toLowerCase();
    try {
      const key = storage.makeKey('cv', ext);
      await storage.putObject({ key, body: part.buffer, contentType: part.mimetype });
      cv.storage_key = key;
      return cv;
    } catch (err) {
      // A CV is the least important thing in this request. Losing the
      // application because the bucket blinked would be the wrong trade, so
      // the file falls back into the document and the person still exists.
      console.error('[careers] CV to storage failed, keeping inline:', err.message);
    }
  }
  cv.data = part.buffer.toString('base64');
  return cv;
}

/**
 * POST /api/public/careers/apply
 * multipart or JSON: { full_name, phone, branch, city?, mobility?,
 *                      gan_experience?, email?, message?, cv? }
 */
async function publicApply(req, res, next) {
  try {
    const b = req.body || {};
    const full_name = clean(b.full_name, 80);
    const phoneRaw = clean(b.phone, 30);
    const phone = recruitment.normalizePhone(phoneRaw);

    if (!full_name) return res.status(400).json({ error: 'נא למלא שם מלא' });
    // normalizePhone is a NORMALISER, not a validator — mail-sorter hands it
    // whatever a parser found and it is right to keep that. Here the caller is
    // a stranger typing into a form, and "123" would become a candidate with a
    // number nobody can ring: a row on a manager's screen that can only ever
    // be archived. Nine digits is the shortest real Israeli number; fifteen is
    // the international maximum, so anything longer is a paste accident.
    const digits = phone.replace(/\D/g, '');
    if (!phone || digits.length < 9 || digits.length > 15) {
      return res.status(400).json({ error: 'מספר טלפון לא תקין' });
    }
    if (!clean(b.branch, 60)) return res.status(400).json({ error: 'נא לבחור סניף' });

    let cv = null;
    try {
      cv = await storeCv(req.file);
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }

    const branches = await Branch.find({}).select('name').lean();
    const { candidate, created, reopened } = await recruitment.intake({
      full_name,
      phone: phoneRaw,
      requested_branch: clean(b.branch, 60),
      message: clean(b.message, 1000),
      city: clean(b.city, 60),
      mobility: b.mobility,
      gan_experience: b.gan_experience,
      email: clean(b.email, 120),
      cv,
      source: 'website',
      at: new Date(),
    }, branches);

    if (!candidate) return res.status(400).json({ error: 'מספר טלפון לא תקין' });

    // Every notification is best-effort and independent. A person who filled
    // in a form has done their part; a mail server having a bad morning must
    // not turn that into an error message they can do nothing about.
    notifyManagers(candidate, { created, reopened })
      .catch(err => console.error('[careers] manager notify failed:', err.message));
    confirmToApplicant(candidate)
      .catch(err => console.error('[careers] applicant email failed:', err.message));

    // Deliberately the same answer whether this phone was already on file.
    // "You have applied before" is a fact about our records, and this endpoint
    // answers strangers.
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
}

/** The branch's managers, plus the office, by email and in the app. */
async function notifyManagers(candidate, { created, reopened }) {
  const branchIds = candidate.branch_ids || [];

  const recipientIds = new Set();
  for (const bid of branchIds) {
    const ids = await notificationService.branchManagerIds(bid).catch(() => []);
    ids.forEach(id => recipientIds.add(String(id)));
  }
  // The office sees every application, including the ones that chose no gan —
  // somebody has to own "מענה כללי" or it is owned by nobody.
  const office = await User.find({ role: { $in: ['system_admin', 'accountant'] }, is_active: { $ne: false } })
    .select('_id email').lean();
  office.forEach(u => recipientIds.add(String(u._id)));

  const where = candidate.requested_branch || 'לא נבחר סניף';
  const headline = reopened ? 'מועמד/ת חזר/ה ופנה/תה' : created ? 'מועמד/ת חדש/ה' : 'פנייה נוספת ממועמד/ת';

  for (const recipient_id of recipientIds) {
    notificationService.createEvent({
      type: 'new_candidate',
      ref_collection: 'Candidate',
      ref_id: candidate._id,
      recipient_id,
      title: `${headline} — גיוס`,
      body: `${candidate.full_name} · ${where}`,
      url: '/recruitment',
    }).catch(err => console.error('[careers] push create failed:', err.message));
  }

  // Email goes to the same people, by address.
  const emails = new Set(office.map(u => u.email).filter(Boolean));
  for (const bid of branchIds) {
    const managers = await User.find(branchManagerFilter(bid)).select('email').lean().catch(() => []);
    managers.forEach(m => m.email && emails.add(m.email));
  }
  if (emails.size === 0) return;

  const yesNo = (v) => (v === 'yes' ? 'כן' : v === 'no' ? 'לא' : 'לא נענה');
  const row = (label, value) => (value ? `<tr><td style="padding:4px 10px;color:#666">${label}</td><td style="padding:4px 10px;font-weight:700">${value}</td></tr>` : '');

  await dispatchEmail({
    to: [...emails],
    subject: `${headline} — ${candidate.full_name} (${where})`,
    html: `<div dir="rtl" style="font-family:Arial,sans-serif">
      <h2 style="margin:0 0 4px">${headline} 🌟</h2>
      <p style="margin:0 0 12px;color:#666">הגיע/ה מדף הדרושים באתר.</p>
      <table style="border-collapse:collapse">
        ${row('שם', candidate.full_name)}
        ${row('טלפון', candidate.phone_raw || candidate.phone)}
        ${row('סניף מבוקש', where)}
        ${row('עיר מגורים', candidate.city)}
        ${row('ניידות', yesNo(candidate.mobility))}
        ${row('ניסיון בגן ילדים', yesNo(candidate.gan_experience))}
        ${row('אימייל', candidate.email)}
        ${row('קורות חיים', candidate.cv?.filename ? 'צורפו' : '')}
      </table>
      <p style="margin-top:16px;color:#888">המועמד/ת מחכה למסך "גיוס" במערכת.</p>
    </div>`,
    text: `${headline}: ${candidate.full_name}, ${candidate.phone_raw || candidate.phone}, ${where}`,
  });
}

/** One line back to the person, so they know it did not vanish. */
async function confirmToApplicant(candidate) {
  if (!candidate.email) return;
  const text = 'תודה שפניתם לגן החלומות! קיבלנו את הפנייה שלכם ונחזור אליכם בהקדם.';
  await dispatchEmail({
    to: candidate.email,
    subject: 'גן החלומות — קיבלנו את המועמדות שלך',
    html: `<div dir="rtl" style="font-family:Arial,sans-serif">
      <h2 style="margin:0 0 8px">קיבלנו את המועמדות שלך 🌈</h2>
      <p>${text}</p>
      <p style="color:#888;margin-top:16px">גן החלומות — מעצבים את דור העתיד באהבה</p>
    </div>`,
    text,
  });
}

module.exports = { publicBranches, publicApply, CV_TYPES, MAX_CV_BYTES };
