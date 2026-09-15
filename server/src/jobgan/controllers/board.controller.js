const { getModels } = require('../db');
const { AREAS, ROLES, SCOPES, SALARY_UNITS, AREA_IDS, ROLE_IDS } = require('../constants');

/**
 * The public board. No login, no token, nothing personal in or out.
 *
 * ORDERING IS RELEVANCE, NEVER MONEY. A tier buys a marked badge, photographs,
 * a longer description and one clearly-labelled slot at the top — it does not
 * buy the order of results. The moment a jobseeker can feel that she is being
 * shown what pays us rather than what suits her, the only asset this product
 * has is gone, and it does not come back.
 */

/** Nothing about the employer beyond what an ad has to say. No contact details. */
function publicJob(job, employer) {
  return {
    id: job._id,
    title: job.title,
    area: job.area,
    role: job.role,
    scope: job.scope,
    city: job.city,
    salary_min: job.salary_min,
    salary_max: job.salary_max,
    salary_unit: job.salary_unit,
    starts_on: job.starts_on,
    description: job.description,
    tier: job.tier,
    promoted: job.tier >= 2,
    published_at: job.published_at,
    gan_name: employer ? employer.gan_name : '',
  };
}

/** The closed lists, so the front-end never hard-codes them. */
function meta(req, res) {
  res.json({ areas: AREAS, roles: ROLES, scopes: SCOPES, salary_units: SALARY_UNITS });
}

async function list(req, res, next) {
  try {
    const { Job, Employer } = getModels();

    const filter = { status: 'published' };
    if (req.query.area && AREA_IDS.includes(req.query.area)) filter.area = req.query.area;
    if (req.query.role && ROLE_IDS.includes(req.query.role)) filter.role = req.query.role;

    const minSalary = Number(req.query.min_salary);
    if (Number.isFinite(minSalary) && minSalary > 0) filter.salary_max = { $gte: minSalary };

    // An expired ad is not shown even if the sweeper has not run yet — the
    // sweeper is a tidier, not the thing that decides what is live.
    filter.$or = [{ expires_at: null }, { expires_at: { $gt: new Date() } }];

    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const skip = Math.max(Number(req.query.skip) || 0, 0);

    const jobs = await Job.find(filter)
      .sort({ published_at: -1 })
      .skip(skip).limit(limit)
      .lean();

    const employers = await Employer.find(
      { _id: { $in: jobs.map(j => j.employer_id) } },
    ).select('gan_name').lean();
    const byId = Object.fromEntries(employers.map(e => [String(e._id), e]));

    const total = await Job.countDocuments(filter);

    return res.json({
      jobs: jobs.map(j => publicJob(j, byId[String(j.employer_id)])),
      total,
      // Said plainly rather than implied, because a board that silently
      // reordered itself would be indistinguishable from this one.
      ordering: 'relevance',
    });
  } catch (err) { return next(err); }
}

async function one(req, res, next) {
  try {
    const { Job, Employer } = getModels();
    const job = await Job.findOne({ _id: req.params.id, status: 'published' }).lean();
    if (!job) return res.status(404).json({ error: 'המשרה לא נמצאה או שאינה פעילה.' });
    const employer = await Employer.findById(job.employer_id).select('gan_name').lean();
    return res.json({ job: publicJob(job, employer) });
  } catch (err) { return next(err); }
}

/** How many live jobs sit in each area, so an empty area is visibly empty. */
async function counts(req, res, next) {
  try {
    const { Job } = getModels();
    const rows = await Job.aggregate([
      { $match: { status: 'published', $or: [{ expires_at: null }, { expires_at: { $gt: new Date() } }] } },
      { $group: { _id: '$area', n: { $sum: 1 } } },
    ]);
    const byArea = Object.fromEntries(AREA_IDS.map(a => [a, 0]));
    for (const r of rows) byArea[r._id] = r.n;
    return res.json({ by_area: byArea, total: rows.reduce((s, r) => s + r.n, 0) });
  } catch (err) { return next(err); }
}

module.exports = { meta, list, one, counts, publicJob };
