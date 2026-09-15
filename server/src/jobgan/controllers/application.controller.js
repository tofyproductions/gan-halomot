const { getModels } = require('../db');
const mail = require('../mail');
const { labelOf, AREAS, ROLES } = require('../constants');

const ANSWER_DAYS = 14;

/**
 * What the gan is shown BEFORE it opens the application: nothing that
 * identifies her. The policy promises that details are revealed on opening,
 * and a list that shows the name has already broken it.
 */
function listedForEmployer(app, seeker, job) {
  const opened = Boolean(app.opened_at);
  const base = {
    id: app._id,
    job_id: app.job_id,
    job_title: job ? job.title : '',
    status: app.status,
    created_at: app.created_at,
    opened: opened,
    deletion_requested: app.deletion_requested,
    completeness: seeker && seeker.completeness ? seeker.completeness() : { filled: 0, total: 7 },
  };
  if (!opened) return base;
  /**
   * She deleted her account after applying.
   *
   * Reading her name off `null` here took the gan's whole inbox down with a
   * 500 — not the row, the page: one deleted account and the gan can no longer
   * see ANY of its applicants. Found by the end-to-end test, and it would have
   * been found in production by a gan that could not work out why the screen
   * was blank.
   *
   * The row stays and says what happened. The gan applied to her, she left,
   * and the honest answer is the one that keeps the rest of the list readable.
   */
  if (!seeker) {
    return { ...base, deleted_by_seeker: true, message: app.message };
  }
  return {
    ...base,
    full_name: seeker.full_name,
    phone: seeker.phone,
    email: seeker.email,
    areas: (seeker.areas || []).map(a => labelOf(AREAS, a)),
    roles: (seeker.roles || []).map(r => labelOf(ROLES, r)),
    scope: seeker.scope,
    available_from: seeker.available_from,
    about: seeker.about,
    experience_years: seeker.experience_years,
    training: seeker.training,
    references: seeker.references,
    police_cert_declared: seeker.police_cert_declared,
    police_cert_valid_to: seeker.police_cert_valid_to,
    message: app.message,
  };
}

/** She applies. One row per person per job; a second press is not a second row. */
async function apply(req, res, next) {
  try {
    const { Job, Seeker, Application } = getModels();

    const job = await Job.findOne({ _id: req.params.jobId, status: 'published' });
    if (!job) return res.status(404).json({ error: 'המשרה אינה פעילה.' });
    if (job.expires_at && job.expires_at <= new Date()) {
      return res.status(410).json({ error: 'המשרה נסגרה.' });
    }

    const seeker = await Seeker.findById(req.seekerId);
    if (!seeker) return res.status(404).json({ error: 'החשבון לא נמצא.' });

    const existing = await Application.findOne({ job_id: job._id, seeker_id: seeker._id });
    if (existing) {
      return res.status(409).json({ error: 'כבר הגשת מועמדות למשרה הזו.', application: { id: existing._id, status: existing.status } });
    }

    const now = new Date();
    const application = await Application.create({
      job_id: job._id,
      seeker_id: seeker._id,
      employer_id: job.employer_id,
      message: String(req.body.message || '').trim().slice(0, 1000),
      status: 'new',
      auto_answer_at: new Date(now.getTime() + ANSWER_DAYS * 86400000),
    });

    // Mail AFTER the row is committed, and it cannot throw: her application is
    // saved whether or not anyone's mail server answers.
    const { Employer } = getModels();
    const employer = await Employer.findById(job.employer_id).lean();
    const waiting = await Application.countDocuments({ employer_id: job.employer_id, status: 'new' });
    if (employer) await mail.newApplication({ employer, job, applicationsWaiting: waiting });

    return res.status(201).json({
      application: { id: application._id, status: application.status, created_at: application.created_at },
      message: 'המועמדות נשלחה. הגן יראה את פרטייך כשיפתח אותה.',
    });
  } catch (err) {
    // The unique index is the real guard against a double press racing itself.
    if (err && err.code === 11000) {
      return res.status(409).json({ error: 'כבר הגשת מועמדות למשרה הזו.' });
    }
    return next(err);
  }
}

/** Her own applications. */
async function mine(req, res, next) {
  try {
    const { Application, Job } = getModels();
    const apps = await Application.find({ seeker_id: req.seekerId }).sort({ created_at: -1 }).lean();
    const jobs = await Job.find({ _id: { $in: apps.map(a => a.job_id) } }).select('title area role').lean();
    const byId = Object.fromEntries(jobs.map(j => [String(j._id), j]));
    return res.json({
      applications: apps.map(a => {
        const j = byId[String(a.job_id)] || {};
        return {
          id: a._id,
          status: a.status,
          created_at: a.created_at,
          answered_at: a.answered_at,
          job_title: j.title || '',
          area: j.area ? labelOf(AREAS, j.area) : '',
          role: j.role ? labelOf(ROLES, j.role) : '',
        };
      }),
    });
  } catch (err) { return next(err); }
}

/** The gan's inbox. Scoped by its own id — never by a parameter. */
async function forEmployer(req, res, next) {
  try {
    const { Application, Seeker, Job } = getModels();
    const filter = { employer_id: req.employerId };
    if (req.query.job_id) filter.job_id = req.query.job_id;
    if (req.query.status) filter.status = req.query.status;

    const apps = await Application.find(filter).sort({ created_at: -1 }).limit(200).lean();
    const seekers = await Seeker.find({ _id: { $in: apps.map(a => a.seeker_id) } }).lean();
    const jobs = await Job.find({ _id: { $in: apps.map(a => a.job_id) } }).select('title').lean();
    const sById = Object.fromEntries(seekers.map(s => [String(s._id), s]));
    const jById = Object.fromEntries(jobs.map(j => [String(j._id), j]));

    const { Seeker: SeekerModel } = getModels();
    return res.json({
      applications: apps.map(a => {
        const raw = sById[String(a.seeker_id)];
        // hydrate so completeness() exists on a lean object
        const s = raw ? SeekerModel.hydrate(raw) : null;
        return listedForEmployer(a, s, jById[String(a.job_id)]);
      }),
    });
  } catch (err) { return next(err); }
}

/**
 * Opening is the moment her details are revealed, and it is recorded.
 * A promise nobody can check is not a promise.
 */
async function open(req, res, next) {
  try {
    const { Application, Seeker, Job } = getModels();
    const app = await Application.findOne({ _id: req.params.id, employer_id: req.employerId });
    if (!app) return res.status(404).json({ error: 'המועמדות לא נמצאה.' });

    if (!app.opened_at) { app.opened_at = new Date(); await app.save(); }

    const seeker = await Seeker.findById(app.seeker_id);
    const job = await Job.findById(app.job_id).select('title').lean();
    if (!seeker) {
      return res.json({
        application: { ...listedForEmployer(app, null, job), deleted_by_seeker: true },
        notice: 'המועמדת מחקה את חשבונה.',
      });
    }
    return res.json({ application: listedForEmployer(app, seeker, job) });
  } catch (err) { return next(err); }
}

/**
 * The two buttons. Every answer reaches her, including the one nobody enjoys —
 * somebody who applied to three jobs and heard nothing from any of them does
 * not come back, and that is the audience being bought with advertising money.
 */
async function answer(req, res, next) {
  try {
    const { Application, Seeker, Job } = getModels();
    const status = String(req.body.status || '');
    if (!['invited', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'תשובה חייבת להיות "invited" או "rejected".' });
    }

    const app = await Application.findOne({ _id: req.params.id, employer_id: req.employerId });
    if (!app) return res.status(404).json({ error: 'המועמדות לא נמצאה.' });
    if (!['new'].includes(app.status)) {
      return res.status(409).json({ error: 'המועמדות כבר נענתה.', status: app.status });
    }

    app.status = status;
    app.answered_at = new Date();
    if (!app.opened_at) app.opened_at = app.answered_at;
    await app.save();

    const seeker = await Seeker.findById(app.seeker_id);
    const job = await Job.findById(app.job_id).lean();
    if (seeker && job) await mail.applicationAnswered({ seeker, job, status });

    return res.json({ application: { id: app._id, status: app.status, answered_at: app.answered_at } });
  } catch (err) { return next(err); }
}

module.exports = { apply, mine, forEmployer, open, answer, listedForEmployer, ANSWER_DAYS };
