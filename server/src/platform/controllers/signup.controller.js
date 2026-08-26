const { controlPlane } = require('../connection');

/**
 * The marketing page's form, and what happens to what it collects.
 *
 * Until now it collected nothing: the submit handler logged to the console and
 * told the visitor the form was not connected yet. A gan owner who reads a
 * price, decides, fills in six fields and presses the button is the most
 * expensive visitor the page will ever get, and that one was being dropped on
 * the floor.
 *
 * Three rules shape everything below.
 *
 * ONE — the row is saved before anybody is emailed, and the mail's outcome is
 * written back onto the row. A lead that lives only in an inbox is gone the day
 * the mail provider's key expires, and nothing announces that; a lead in the
 * database with `notify_error` set is visible in the console the same minute.
 *
 * TWO — the visitor is told it worked as soon as it is SAVED, not when the mail
 * leaves. Mail through the Apps Script relay retries for up to ninety seconds,
 * and a person watching a spinner that long assumes it failed and submits
 * again.
 *
 * THREE — nothing here is behind a login, so it is reachable by anything on the
 * internet. Hence the honeypot, the per-address ceiling, and the size caps in
 * the schema.
 */

// A submission every few seconds from one address is not a gan owner. Kept in
// memory on purpose: a restart forgetting it costs nothing, and the alternative
// is a collection that grows forever to stop something that has not happened.
const RECENT = new Map();          // ip -> [timestamps]
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 6;

function tooMany(ip) {
  const now = Date.now();
  const hits = (RECENT.get(ip) || []).filter(t => now - t < WINDOW_MS);
  hits.push(now);
  RECENT.set(ip, hits);
  if (RECENT.size > 5000) RECENT.clear();   // ceiling, not bookkeeping
  return hits.length > MAX_PER_WINDOW;
}

const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

/**
 * Israeli mobile and landline, however the person happened to type it —
 * with a leading +972, with dashes, with spaces. Rejecting a real number
 * because it has a hyphen in it loses the lead to punctuation.
 */
function normalisePhone(raw) {
  const digits = String(raw || '').replace(/[^\d+]/g, '').replace(/^\+972/, '0');
  if (!/^0\d{8,9}$/.test(digits)) return null;
  return digits;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

const BRANCH_OPTIONS = ['1', '2–5', '6–20', '21+'];

function notifyAddress() {
  return process.env.SIGNUP_NOTIFY_EMAIL || 'halom.dreamgan@gmail.com';
}

function notificationHtml(s) {
  const row = (k, v) => `<tr><td style="padding:6px 14px 6px 0;color:#5B7387">${k}</td><td style="padding:6px 0;font-weight:700">${v || '—'}</td></tr>`;
  return `<div dir="rtl" style="font-family:Arial,sans-serif;color:#16324A">
    <h2 style="margin:0 0 4px">הרשמה מוקדמת חדשה</h2>
    <p style="margin:0 0 18px;color:#5B7387">מישהו מילא את הטופס באתר. כדאי להתקשר היום.</p>
    <table style="border-collapse:collapse;font-size:15px">
      ${row('הגן', s.gan_name)}
      ${row('איש קשר', s.full_name)}
      ${row('טלפון', s.phone)}
      ${row('אימייל', s.email)}
      ${row('מספר ילדים', s.children)}
      ${row('מספר סניפים', s.branches)}
      ${row('הערה', s.note)}
      ${row('הגיע מ', s.source || s.referrer)}
    </table>
    <p style="margin:22px 0 0;font-size:13px;color:#5B7387">
      הפנייה שמורה גם בקונסולה, תחת "נרשמים מהאתר".
    </p>
  </div>`;
}

/** Best-effort, and deliberately after the response has gone out. */
async function notify(Signup, doc) {
  try {
    const { dispatchEmail } = require('../../services/email.service');
    await dispatchEmail({
      to: notifyAddress(),
      subject: `הרשמה מוקדמת — ${doc.gan_name} (${doc.full_name})`,
      html: notificationHtml(doc),
      text: `הרשמה מוקדמת חדשה\nגן: ${doc.gan_name}\nאיש קשר: ${doc.full_name}\nטלפון: ${doc.phone}\nאימייל: ${doc.email}\nילדים: ${doc.children || '—'}\nסניפים: ${doc.branches || '—'}`,
    });
    await Signup.updateOne({ _id: doc._id }, { notified_at: new Date(), notify_error: '' });
  } catch (e) {
    // Never thrown onward: the lead is already saved, and a failed email must
    // not turn into an unhandled rejection that takes the process down.
    console.error('signup notification failed:', e.message);
    await Signup.updateOne({ _id: doc._id }, { notify_error: String(e.message).slice(0, 400) }).catch(() => {});
  }
}

/** POST /api/platform/signup — public. */
exports.create = async (req, res, next) => {
  try {
    // The honeypot: a field the stylesheet hides and no person ever sees, so
    // anything in it came from something filling in every input on the page.
    // Answered with a 200 rather than an error — a bot told it failed retries.
    if (clean(req.body.website, 200)) return res.json({ ok: true });

    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
    if (tooMany(ip)) {
      return res.status(429).json({ error: 'נשלחו יותר מדי פניות מהכתובת הזו. נסו שוב בעוד שעה, או התקשרו אלינו.' });
    }

    const gan_name  = clean(req.body.gan, 120);
    const full_name = clean(req.body.name, 120);
    const email     = clean(req.body.email, 160).toLowerCase();
    const phone     = normalisePhone(req.body.phone);
    const branches  = BRANCH_OPTIONS.includes(clean(req.body.branches, 20)) ? clean(req.body.branches, 20) : '';
    const childrenN = parseInt(req.body.children, 10);

    // One field named per message. "שדות חסרים" makes the person hunt.
    if (!gan_name)  return res.status(400).json({ error: 'חסר שם הגן' });
    if (!full_name) return res.status(400).json({ error: 'חסר שם מלא' });
    if (!phone)     return res.status(400).json({ error: 'מספר הטלפון לא נראה תקין — 05… או 0…, עם או בלי מקפים' });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'כתובת האימייל לא נראית תקינה' });

    const { Signup } = await controlPlane();

    const payload = {
      gan_name, full_name, phone, email,
      children: Number.isFinite(childrenN) && childrenN > 0 ? Math.min(childrenN, 100000) : null,
      branches,
      note: clean(req.body.note, 2000),
      source: clean(req.body.source, 200),
      referrer: clean(req.headers.referer, 400),
      user_agent: clean(req.headers['user-agent'], 400),
    };

    // Somebody who presses the button twice, or comes back an hour later
    // because they were not sure it went through, is one lead and not three.
    // Their second attempt is also the more recent truth, so it overwrites.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const existing = await Signup.findOne({ phone, created_at: { $gte: since } });

    let doc;
    if (existing) {
      Object.assign(existing, payload);
      doc = await existing.save();
    } else {
      doc = await Signup.create(payload);
    }

    res.json({ ok: true });

    // After the response, on purpose — see rule TWO above.
    notify(Signup, doc);
  } catch (err) { next(err); }
};

/** GET /api/platform/signups — console. */
exports.list = async (req, res, next) => {
  try {
    const { Signup } = await controlPlane();
    const q = {};
    if (req.query.status) q.status = String(req.query.status);
    const rows = await Signup.find(q).sort({ created_at: -1 }).limit(300).lean();
    res.json(rows);
  } catch (err) { next(err); }
};

/** PATCH /api/platform/signups/:id — console: move it along the pipeline. */
exports.update = async (req, res, next) => {
  try {
    const { Signup } = await controlPlane();
    const patch = {};
    if (req.body.status) {
      if (!['new', 'contacted', 'paid', 'declined'].includes(req.body.status)) {
        return res.status(400).json({ error: 'סטטוס לא מוכר' });
      }
      patch.status = req.body.status;
    }
    if (req.body.note_internal != null) patch.note_internal = clean(req.body.note_internal, 2000);

    const doc = await Signup.findByIdAndUpdate(req.params.id, patch, { new: true });
    if (!doc) return res.status(404).json({ error: 'פנייה לא נמצאה' });
    res.json(doc);
  } catch (err) { next(err); }
};

// Exported for the test suite, which must be able to check the phone rule
// without standing a server up.
exports._normalisePhone = normalisePhone;
