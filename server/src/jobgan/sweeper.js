const { getModels } = require('./db');
const mail = require('./mail');

/**
 * The two clocks nobody presses.
 *
 * An ad expires at 30 days; an application nobody answered is answered at 14.
 * Both exist so that no one is left waiting on a person who simply moved on,
 * which is the ordinary way a jobseeker's week goes and the reason people stop
 * using boards.
 *
 * ORDER MATTERS HERE. Ads are swept first, because closing an ad closes the
 * applications under it — and an application closed by its ad should say "the
 * job closed", not "no answer". Running the two the other way round would tell
 * somebody she was passed over when in fact the position went away.
 */

async function sweepExpiredJobs(now = new Date()) {
  const { Job, Application } = getModels();
  const expired = await Job.find({ status: 'published', expires_at: { $lte: now } }).select('_id');
  if (!expired.length) return { jobs: 0, applications: 0 };

  const ids = expired.map(j => j._id);
  await Job.updateMany(
    { _id: { $in: ids } },
    { $set: { status: 'closed', closed_at: now, close_reason: 'expired' } },
  );
  const r = await Application.updateMany(
    { job_id: { $in: ids }, status: 'new' },
    { $set: { status: 'job_closed', answered_at: now, auto_answered: true } },
  );
  return { jobs: ids.length, applications: r.modifiedCount };
}

async function sweepUnansweredApplications(now = new Date()) {
  const { Application, Job, Seeker } = getModels();
  const due = await Application.find({
    status: 'new', auto_answer_at: { $lte: now },
  }).limit(500);
  if (!due.length) return { answered: 0 };

  let answered = 0;
  for (const app of due) {
    app.status = 'rejected';
    app.answered_at = now;
    app.auto_answered = true;
    await app.save();
    answered++;

    const [job, seeker] = await Promise.all([
      Job.findById(app.job_id).lean(),
      Seeker.findById(app.seeker_id).lean(),
    ]);
    if (job && seeker) await mail.applicationAnswered({ seeker, job, status: 'rejected' });
  }
  return { answered };
}

async function runOnce(now = new Date()) {
  const jobs = await sweepExpiredJobs(now);
  const apps = await sweepUnansweredApplications(now);
  return { ...jobs, auto_answered: apps.answered };
}

/**
 * Hourly is plenty — the deadlines are measured in days, and a job that runs
 * every minute is a job whose failures are noticed a thousand times.
 * `unref()` so the timer never holds the process open in a test.
 */
function start() {
  const HOUR = 60 * 60 * 1000;
  const tick = async () => {
    try {
      const r = await runOnce();
      if (r.jobs || r.auto_answered) console.log('[jobgan] מטאטא:', r);
    } catch (err) {
      console.error('[jobgan] המטאטא נכשל:', err.message);
    }
  };
  const t = setInterval(tick, HOUR);
  if (t.unref) t.unref();
  setTimeout(tick, 30000).unref?.();
  return t;
}

module.exports = { runOnce, sweepExpiredJobs, sweepUnansweredApplications, start };
