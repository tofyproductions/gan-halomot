const { getModels } = require('../db');
const auth = require('../auth');
const mail = require('../mail');
const { AREA_IDS, ROLE_IDS, SCOPE_IDS } = require('../constants');

const ANSWER_DAYS = 14;
const clean = (s) => String(s == null ? '' : s).trim();
const normPhone = (p) => String(p || '').replace(/[-\s]/g, '');
const phoneOk = (p) => /^0\d{8,9}$/.test(normPhone(p));

const publicSeeker = (s) => ({
  id: s._id,
  full_name: s.full_name,
  phone: s.phone,
  email: s.email,
  areas: s.areas,
  roles: s.roles,
  scope: s.scope,
  available_from: s.available_from,
  about: s.about,
  experience_years: s.experience_years,
  training: s.training,
  references: s.references,
  police_cert_declared: s.police_cert_declared,
  police_cert_valid_from: s.police_cert_valid_from,
  police_cert_valid_to: s.police_cert_valid_to,
  wants_job_alerts: s.wants_job_alerts,
  completeness: s.completeness ? s.completeness() : undefined,
});

async function register(req, res, next) {
  try {
    const { Seeker } = getModels();
    const full_name = clean(req.body.full_name);
    const phone = normPhone(req.body.phone);
    const password = String(req.body.password || '');

    if (!full_name) return res.status(400).json({ error: 'שם מלא נדרש.', field: 'full_name' });
    if (!phoneOk(phone)) return res.status(400).json({ error: 'מספר טלפון אינו תקין.', field: 'phone' });
    if (password.length < 8) return res.status(400).json({ error: 'סיסמה חייבת להיות באורך 8 תווים לפחות.', field: 'password' });

    if (await Seeker.findOne({ phone })) {
      return res.status(409).json({ error: 'המספר כבר רשום. אפשר להתחבר.', field: 'phone' });
    }

    const seeker = await Seeker.create({
      full_name, phone,
      email: clean(req.body.email).toLowerCase(),
      password_hash: await auth.hash(password),
      areas: (req.body.areas || []).filter(a => AREA_IDS.includes(a)),
      roles: (req.body.roles || []).filter(r => ROLE_IDS.includes(r)),
      scope: SCOPE_IDS.includes(req.body.scope) ? req.body.scope : 'full',
      available_from: req.body.available_from ? new Date(req.body.available_from) : null,
      about: clean(req.body.about).slice(0, 600),
      wants_job_alerts: Boolean(req.body.wants_job_alerts),
    });

    return res.status(201).json({
      token: auth.sign('seeker', seeker._id, true),
      seeker: publicSeeker(seeker),
    });
  } catch (err) { return next(err); }
}

async function login(req, res, next) {
  try {
    const { Seeker } = getModels();
    const phone = normPhone(req.body.phone);
    const seeker = await Seeker.findOne({ phone });
    if (!seeker || !(await auth.verifyPassword(String(req.body.password || ''), seeker.password_hash))) {
      return res.status(401).json({ error: 'טלפון או סיסמה שגויים.' });
    }
    seeker.last_login_at = new Date();
    await seeker.save();
    return res.json({
      token: auth.sign('seeker', seeker._id, Boolean(req.body.rememberMe)),
      seeker: publicSeeker(seeker),
    });
  } catch (err) { return next(err); }
}

async function me(req, res, next) {
  try {
    const { Seeker } = getModels();
    const seeker = await Seeker.findById(req.seekerId);
    if (!seeker) return res.status(404).json({ error: 'החשבון לא נמצא.' });
    return res.json({ seeker: publicSeeker(seeker) });
  } catch (err) { return next(err); }
}

/** Only her own row, and only the fields a person owns. */
async function updateMe(req, res, next) {
  try {
    const { Seeker } = getModels();
    const seeker = await Seeker.findById(req.seekerId);
    if (!seeker) return res.status(404).json({ error: 'החשבון לא נמצא.' });

    const b = req.body;
    if (b.full_name !== undefined) seeker.full_name = clean(b.full_name) || seeker.full_name;
    if (b.email !== undefined) seeker.email = clean(b.email).toLowerCase();
    if (Array.isArray(b.areas)) seeker.areas = b.areas.filter(a => AREA_IDS.includes(a));
    if (Array.isArray(b.roles)) seeker.roles = b.roles.filter(r => ROLE_IDS.includes(r));
    if (b.scope !== undefined && SCOPE_IDS.includes(b.scope)) seeker.scope = b.scope;
    if (b.available_from !== undefined) seeker.available_from = b.available_from ? new Date(b.available_from) : null;
    if (b.about !== undefined) seeker.about = clean(b.about).slice(0, 600);
    if (b.experience_years !== undefined) {
      const n = Number(b.experience_years);
      seeker.experience_years = Number.isFinite(n) && n >= 0 ? n : null;
    }
    if (b.training !== undefined) seeker.training = clean(b.training);
    if (b.references !== undefined) seeker.references = clean(b.references);
    if (b.wants_job_alerts !== undefined) seeker.wants_job_alerts = Boolean(b.wants_job_alerts);

    // The declaration — and only the declaration. No file is accepted here,
    // and no route exists that would accept one.
    if (b.police_cert_declared !== undefined) {
      seeker.police_cert_declared = Boolean(b.police_cert_declared);
      seeker.police_cert_valid_from = b.police_cert_valid_from ? new Date(b.police_cert_valid_from) : null;
      seeker.police_cert_valid_to = b.police_cert_valid_to ? new Date(b.police_cert_valid_to) : null;
    }

    await seeker.save();
    return res.json({ seeker: publicSeeker(seeker) });
  } catch (err) { return next(err); }
}

/**
 * Delete the account, immediately and for real.
 *
 * WHAT THIS CANNOT DO, and what the privacy policy says out loud: a gan she
 * applied to already holds a copy, on its own side, under its own retention.
 * Pretending otherwise would be a promise broken in exactly the moment
 * somebody checks. So her applications are marked `deletion_requested` before
 * the row goes — the gan sees the request the next time it looks. That is not
 * enforcement, and it is more than any board does today.
 */
async function deleteMe(req, res, next) {
  try {
    const { Seeker, Application } = getModels();
    const seeker = await Seeker.findById(req.seekerId);
    if (!seeker) return res.status(404).json({ error: 'החשבון לא נמצא.' });

    const marked = await Application.updateMany(
      { seeker_id: seeker._id },
      { $set: { deletion_requested: true } },
    );
    await Seeker.deleteOne({ _id: seeker._id });

    return res.json({
      deleted: true,
      applications_marked: marked.modifiedCount,
      notice: 'החשבון נמחק. גן שכבר קיבל את פנייתך מחזיק עותק אצלו, ועודכן בבקשת המחיקה.',
    });
  } catch (err) { return next(err); }
}

module.exports = { register, login, me, updateMe, deleteMe, publicSeeker, ANSWER_DAYS };
