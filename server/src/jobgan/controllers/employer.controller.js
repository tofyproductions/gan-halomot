const { getModels } = require('../db');
const auth = require('../auth');
const { screenText, AREA_IDS, ROLE_IDS, SCOPE_IDS, SALARY_UNIT_IDS } = require('../constants');
const mail = require('../mail');

const AD_DAYS = 30;
const ANSWER_DAYS = 14;

const clean = (s) => String(s == null ? '' : s).trim();
const phoneOk = (p) => /^0\d{8,9}$/.test(String(p).replace(/[-\s]/g, ''));
const emailOk = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e));

/** The gan as it is safe to hand back to itself. No hash, ever. */
const publicEmployer = (e) => ({
  id: e._id,
  gan_name: e.gan_name,
  contact_name: e.contact_name,
  contact_phone: e.contact_phone,
  email: e.email,
  business_id: e.business_id,
  status: e.status,
  is_customer: Boolean(e.tenant_slug),
  max_tier: e.tenant_slug ? 3 : 1,
});

async function register(req, res, next) {
  try {
    const { Employer } = getModels();
    const gan_name = clean(req.body.gan_name);
    const contact_name = clean(req.body.contact_name);
    const contact_phone = clean(req.body.contact_phone).replace(/[-\s]/g, '');
    const email = clean(req.body.email).toLowerCase();
    const business_id = clean(req.body.business_id);
    const password = String(req.body.password || '');

    if (!gan_name) return res.status(400).json({ error: 'שם הגן נדרש.', field: 'gan_name' });
    if (!contact_name) return res.status(400).json({ error: 'שם איש הקשר נדרש.', field: 'contact_name' });
    if (!phoneOk(contact_phone)) return res.status(400).json({ error: 'מספר טלפון אינו תקין.', field: 'contact_phone' });
    if (!emailOk(email)) return res.status(400).json({ error: 'כתובת אימייל אינה תקינה.', field: 'email' });
    if (password.length < 8) return res.status(400).json({ error: 'סיסמה חייבת להיות באורך 8 תווים לפחות.', field: 'password' });

    if (await Employer.findOne({ email })) {
      return res.status(409).json({ error: 'כתובת האימייל כבר רשומה. אפשר להתחבר.', field: 'email' });
    }

    const employer = await Employer.create({
      gan_name, contact_name, contact_phone, email, business_id,
      password_hash: await auth.hash(password),
      status: 'pending',
    });

    return res.status(201).json({
      token: auth.sign('employer', employer._id, true),
      employer: publicEmployer(employer),
      // Said at signup rather than discovered at publish: the first ad waits
      // for a person, and a gan that is not told assumes the site is broken.
      notice: 'המודעה הראשונה שלך תיבדק על ידינו ותפורסם עד שלושה ימי עסקים. המודעות הבאות יתפרסמו מיד.',
    });
  } catch (err) { return next(err); }
}

async function login(req, res, next) {
  try {
    const { Employer } = getModels();
    const email = clean(req.body.email).toLowerCase();
    const password = String(req.body.password || '');
    const employer = await Employer.findOne({ email });
    // Same answer for "no such account" and "wrong password": the difference
    // tells a stranger which addresses are registered.
    if (!employer || !(await auth.verifyPassword(password, employer.password_hash))) {
      return res.status(401).json({ error: 'אימייל או סיסמה שגויים.' });
    }
    if (employer.status === 'blocked') {
      return res.status(403).json({ error: 'החשבון חסום. לפרטים יש לפנות אלינו.' });
    }
    return res.json({
      token: auth.sign('employer', employer._id, Boolean(req.body.rememberMe)),
      employer: publicEmployer(employer),
    });
  } catch (err) { return next(err); }
}

async function me(req, res, next) {
  try {
    const { Employer } = getModels();
    const employer = await Employer.findById(req.employerId);
    if (!employer) return res.status(404).json({ error: 'החשבון לא נמצא.' });
    return res.json({ employer: publicEmployer(employer) });
  } catch (err) { return next(err); }
}

/**
 * Publish a job.
 *
 * Two gates, in this order and for different reasons:
 *   1. the wording screen — refuses nobody, but an ad it catches goes to
 *      `draft` with the grounds attached, so the gan can fix it. Most gan
 *      managers do not know these phrases are unlawful.
 *   2. the account's own state — a gan with no approved ad yet lands in
 *      `pending` and waits for a person.
 */
async function createJob(req, res, next) {
  try {
    const { Employer, Job } = getModels();
    const employer = await Employer.findById(req.employerId);
    if (!employer) return res.status(404).json({ error: 'החשבון לא נמצא.' });
    if (employer.status === 'blocked') return res.status(403).json({ error: 'החשבון חסום.' });

    const title = clean(req.body.title);
    const area = clean(req.body.area);
    const role = clean(req.body.role);
    const scope = clean(req.body.scope);
    const city = clean(req.body.city);
    const description = clean(req.body.description);
    const salary_unit = clean(req.body.salary_unit);
    const salary_min = Number(req.body.salary_min);
    const salary_max = Number(req.body.salary_max);
    const starts_on = req.body.starts_on ? new Date(req.body.starts_on) : null;

    if (!title) return res.status(400).json({ error: 'כותרת המשרה נדרשת.', field: 'title' });
    if (!AREA_IDS.includes(area)) return res.status(400).json({ error: 'יש לבחור אזור מהרשימה.', field: 'area' });
    if (!ROLE_IDS.includes(role)) return res.status(400).json({ error: 'יש לבחור תפקיד מהרשימה.', field: 'role' });
    if (!SCOPE_IDS.includes(scope)) return res.status(400).json({ error: 'יש לבחור היקף משרה.', field: 'scope' });
    if (!SALARY_UNIT_IDS.includes(salary_unit)) return res.status(400).json({ error: 'יש לבחור אם השכר לשעה או לחודש.', field: 'salary_unit' });
    if (!Number.isFinite(salary_min) || !Number.isFinite(salary_max) || salary_min <= 0 || salary_max <= 0) {
      return res.status(400).json({ error: 'טווח שכר הוא שדה חובה. מודעה בלי שכר כמעט אף פעם לא נענית.', field: 'salary_min' });
    }
    if (salary_max < salary_min) return res.status(400).json({ error: 'השכר המרבי נמוך מהמזערי.', field: 'salary_max' });
    if (!starts_on || Number.isNaN(starts_on.getTime())) {
      return res.status(400).json({ error: 'תאריך תחילת עבודה נדרש.', field: 'starts_on' });
    }

    // The screen reads everything a person wrote, not only the description.
    const grounds = screenText(`${title} ${city} ${description}`);

    // The free tier's ceiling is a live-ad count, not a total.
    const liveCount = await Job.countDocuments({
      employer_id: employer._id, status: { $in: ['published', 'pending'] },
    });
    const tier = 1;
    const FREE_LIVE_ADS = 2;
    if (liveCount >= FREE_LIVE_ADS) {
      return res.status(402).json({
        error: `במסלול החינמי אפשר להחזיק עד ${FREE_LIVE_ADS} מודעות פעילות בו זמנית. אפשר לסגור מודעה קיימת, או לפנות אלינו.`,
        code: 'FREE_TIER_LIMIT',
      });
    }

    let status = employer.status === 'active' ? 'published' : 'pending';
    if (grounds.length) status = 'draft';

    const now = new Date();
    const job = await Job.create({
      employer_id: employer._id,
      title, area, role, scope, city, description,
      salary_min, salary_max, salary_unit, starts_on,
      tier,
      status,
      flagged_grounds: grounds,
      published_at: status === 'published' ? now : null,
      expires_at: status === 'published' ? new Date(now.getTime() + AD_DAYS * 86400000) : null,
    });

    if (grounds.length) {
      return res.status(200).json({
        job,
        blocked: true,
        grounds,
        message: 'המודעה נשמרה ולא פורסמה. נוסח שדורש או מעדיף לפי '
          + grounds.join(', ')
          + ' אסור על פי חוק שוויון ההזדמנויות בעבודה, והאחריות חלה גם עלינו כמפרסמים. '
          + 'אפשר לתקן ולפרסם.',
      });
    }

    return res.status(201).json({
      job,
      message: status === 'published'
        ? 'המודעה פורסמה.'
        : 'המודעה התקבלה ותפורסם עד שלושה ימי עסקים. זו הבדיקה החד־פעמית של גן חדש.',
    });
  } catch (err) { return next(err); }
}

/** The gan's own ads. Never anybody else's — the filter is the id, not a param. */
async function myJobs(req, res, next) {
  try {
    const { Job, Application } = getModels();
    const jobs = await Job.find({ employer_id: req.employerId }).sort({ created_at: -1 }).lean();
    const counts = await Application.aggregate([
      { $match: { employer_id: new (require('mongoose').Types.ObjectId)(String(req.employerId)) } },
      { $group: { _id: { job: '$job_id', status: '$status' }, n: { $sum: 1 } } },
    ]);
    const byJob = {};
    for (const c of counts) {
      const k = String(c._id.job);
      byJob[k] = byJob[k] || { total: 0, new: 0 };
      byJob[k].total += c.n;
      if (c._id.status === 'new') byJob[k].new += c.n;
    }
    return res.json({
      jobs: jobs.map(j => ({ ...j, applications: byJob[String(j._id)] || { total: 0, new: 0 } })),
    });
  } catch (err) { return next(err); }
}

/**
 * Close an ad — and with it every application still waiting under it.
 *
 * The cascade is the point. Two mechanics we set independently (an ad expires
 * at 30 days, an unanswered application is answered at 14) would otherwise
 * leave a person who applied on day 29 waiting on a job that no longer exists.
 * A small edge case that produces a large bad feeling.
 */
async function closeJob(req, res, next) {
  try {
    const { Job, Application } = getModels();
    const job = await Job.findOne({ _id: req.params.id, employer_id: req.employerId });
    if (!job) return res.status(404).json({ error: 'המודעה לא נמצאה.' });
    if (job.status === 'closed') return res.json({ job, closed_applications: 0 });

    job.status = 'closed';
    job.closed_at = new Date();
    job.close_reason = ['filled', 'withdrawn'].includes(req.body.reason) ? req.body.reason : 'withdrawn';
    await job.save();

    const r = await Application.updateMany(
      { job_id: job._id, status: 'new' },
      { $set: { status: 'job_closed', answered_at: new Date() } },
    );

    return res.json({ job, closed_applications: r.modifiedCount });
  } catch (err) { return next(err); }
}

module.exports = {
  register, login, me, createJob, myJobs, closeJob,
  publicEmployer, AD_DAYS, ANSWER_DAYS,
};
