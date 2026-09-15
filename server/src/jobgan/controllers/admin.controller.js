const { getModels } = require('../db');
const mail = require('../mail');

const AD_DAYS = 30;

/**
 * The manual review queue. One operator, behind a shared secret.
 *
 * WHY A PERSON LOOKS AT ALL. The board is open to every gan in Israel, which
 * is what keeps it from being a board with a handful of ads — and it means
 * anybody can sign up claiming to be a gan. A jobs board for women is a known
 * target for harvesting names and telephone numbers, and we have just promised
 * every applicant that only a gan she wrote to can see her.
 *
 * That promise is worth exactly as much as it is hard to impersonate a gan. So
 * the FIRST ad of every new gan is read by a person; everything after that
 * publishes immediately. At launch there are few ads and this costs minutes a
 * day. If the queue ever grows, that is a good problem and the moment to
 * automate — not before.
 */

async function queue(req, res, next) {
  try {
    const { Job, Employer } = getModels();
    const jobs = await Job.find({ status: { $in: ['pending', 'draft'] } })
      .sort({ created_at: 1 }).limit(200).lean();
    const employers = await Employer.find({ _id: { $in: jobs.map(j => j.employer_id) } }).lean();
    const byId = Object.fromEntries(employers.map(e => [String(e._id), e]));
    return res.json({
      jobs: jobs.map(j => ({
        ...j,
        employer: byId[String(j.employer_id)]
          ? {
            id: byId[String(j.employer_id)]._id,
            gan_name: byId[String(j.employer_id)].gan_name,
            contact_name: byId[String(j.employer_id)].contact_name,
            contact_phone: byId[String(j.employer_id)].contact_phone,
            email: byId[String(j.employer_id)].email,
            business_id: byId[String(j.employer_id)].business_id,
            status: byId[String(j.employer_id)].status,
          }
          : null,
      })),
      waiting: jobs.length,
    });
  } catch (err) { return next(err); }
}

/**
 * Approve: the ad goes live AND the gan stops needing review.
 *
 * Both halves matter. Approving only the ad would send the same gan back to
 * the queue tomorrow, which is a queue that grows with use rather than with
 * new gans — and the review exists to check the GAN, not the sentence.
 */
async function approve(req, res, next) {
  try {
    const { Job, Employer } = getModels();
    const job = await Job.findById(req.params.id);
    if (!job) return res.status(404).json({ error: 'המודעה לא נמצאה.' });
    if (job.status === 'published') return res.json({ job, already: true });

    const employer = await Employer.findById(job.employer_id);
    if (!employer) return res.status(404).json({ error: 'הגן לא נמצא.' });

    const now = new Date();
    job.status = 'published';
    job.published_at = now;
    job.expires_at = new Date(now.getTime() + AD_DAYS * 86400000);
    job.flagged_grounds = [];
    await job.save();

    const firstApproval = employer.status !== 'active';
    if (firstApproval) {
      employer.status = 'active';
      employer.reviewed_at = now;
      await employer.save();
      await mail.employerApproved({ employer });
    }

    return res.json({ job, employer_activated: firstApproval });
  } catch (err) { return next(err); }
}

/** Refuse. The gan is told why, because a silent refusal teaches nothing. */
async function reject(req, res, next) {
  try {
    const { Job, Employer } = getModels();
    const job = await Job.findById(req.params.id);
    if (!job) return res.status(404).json({ error: 'המודעה לא נמצאה.' });

    job.status = 'closed';
    job.closed_at = new Date();
    job.close_reason = 'removed';
    await job.save();

    // Blocking the gan is a separate, heavier act, taken only when asked for.
    if (req.body.block_employer) {
      const employer = await Employer.findById(job.employer_id);
      if (employer) {
        employer.status = 'blocked';
        employer.status_note = String(req.body.note || '').slice(0, 500);
        await employer.save();
      }
    }
    return res.json({ job, blocked_employer: Boolean(req.body.block_employer) });
  } catch (err) { return next(err); }
}

module.exports = { queue, approve, reject };
