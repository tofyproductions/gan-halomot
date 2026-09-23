const { Photo, Setting, Child, ChildFaceReference } = require('../models');
const storage = require('./storage.service');
const { dispatchEmail } = require('./email.service');

/**
 * תמונה חיה שנתיים לימודים, ואז נמחקת.
 *
 * This is the only irreversible thing the whole feature does, so it is built
 * to be boring: a rule a person can say out loud, a cap on how much damage one
 * run can do, and a refusal to touch anything it did not put there.
 *
 * WHY TWO YEARS AND NOT "UNTIL STORAGE FILLS". R2 is a bill, not a disk —
 * measured at 318KB per photograph through the gan's own pipeline, a normal
 * year is about 7GB and five dollars a month would buy decades. A
 * fill-based rule would also be unpredictable: one busy month would silently
 * delete Hanukkah, and nothing can be promised to a parent about a system that
 * behaves that way. "תמונות נשמרות שנתיים" is a sentence you can say.
 *
 * WHY IT CANNOT EAT THE CONTRACTS. Photographs, scanned contracts, ID copies
 * and payslips all live in the same bucket, and only the photographs are
 * scoped to academic years. So this walks the Photo COLLECTION and deletes the
 * two keys each row names. It never lists the bucket, never matches on a path
 * prefix, and therefore has no way to reach a file that is not a photograph —
 * which is a property of the design rather than a rule someone has to
 * remember.
 */

// Daily is often enough for a two-year window, and the first run waits so a
// deploy loop does not sweep on every restart.
const EVERY_MS = 24 * 60 * 60 * 1000;
const FIRST_RUN_MS = 20 * 60 * 1000;

/**
 * The most this job will delete in one run.
 *
 * Not a performance limit. If a date-arithmetic mistake ever made "older than
 * two years" mean "everything", this is the difference between losing a
 * morning's photographs and losing the gan's entire history before anybody
 * reads a log.
 */
const MAX_PER_RUN = 500;

const CAP_KEY = 'photo_storage_cap_gb';
const CAP_ALERTED_KEY = 'photo_storage_cap_alerted';
const DEFAULT_CAP_GB = 40;

/**
 * The first day whose photographs are still kept.
 *
 * The gan's year turns on 1 September. Keeping the current year and the one
 * before it means a photograph from תשפ"ז survives all of תשפ"ח and goes at
 * the start of תשפ"ט — which is what "two academic years" means to the person
 * who asked for it.
 */
function cutoffDate(now = new Date()) {
  const year = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
  return `${year - 1}-09-01`;
}

/** Total bytes the photographs occupy, straight from the rows. */
async function usedBytes() {
  const [row] = await Photo.aggregate([
    { $group: { _id: null, bytes: { $sum: '$bytes' }, n: { $sum: 1 } } },
  ]);
  return { bytes: row ? row.bytes : 0, count: row ? row.n : 0 };
}

/**
 * The cap ALERTS. It never deletes.
 *
 * A ceiling that deletes is a ceiling that decides, one busy month, to remove
 * photographs a family was promised for two years. Telling somebody is the
 * whole job.
 */
async function checkCap(used) {
  const capDoc = await Setting.findOne({ key: CAP_KEY }).lean();
  const capGb = (capDoc && capDoc.value && capDoc.value.gb) || DEFAULT_CAP_GB;
  const usedGb = used.bytes / 1024 / 1024 / 1024;
  if (usedGb < capGb) {
    await Setting.deleteOne({ key: CAP_ALERTED_KEY });
    return { over: false, used_gb: Number(usedGb.toFixed(1)), cap_gb: capGb };
  }

  // Once, not every day, until it drops back under.
  const already = await Setting.findOne({ key: CAP_ALERTED_KEY }).lean();
  if (!already) {
    const to = (await Setting.findOne({ key: 'face_alert_email' }).lean())?.value?.email
      || process.env.FACE_ALERT_EMAIL;
    if (to) {
      await dispatchEmail({
        to,
        subject: `התמונות עברו ${capGb} ג'יגה`,
        text: [
          `התמונות בגן תופסות ${usedGb.toFixed(1)} ג'יגה, מעל התקרה של ${capGb}.`,
          '',
          'שום דבר לא נמחק בגלל זה ולא יימחק — התקרה רק מתריעה.',
          'מחיקה קורית רק לפי גיל: תמונה חיה שנתיים לימודים.',
          '',
          'אפשר להעלות את התקרה בהגדרה photo_storage_cap_gb.',
        ].join('\n'),
      });
    }
    await Setting.updateOne({ key: CAP_ALERTED_KEY },
      { $set: { key: CAP_ALERTED_KEY, value: { at: new Date() } } }, { upsert: true });
  }
  return { over: true, used_gb: Number(usedGb.toFixed(1)), cap_gb: capGb };
}

/**
 * A child who has left stops being recognisable, immediately.
 *
 * Their photographs stay — a family does not lose its memories because a year
 * ended, and the group shots contain other people's children anyway — but the
 * template is what makes them findable by a machine, and there is no longer
 * any reason for it to exist. That is the promise the consent screen makes,
 * and it has to be kept by something rather than remembered by somebody.
 */
async function forgetDepartedChildren() {
  const known = await ChildFaceReference.distinct('child_id');
  if (!known.length) return 0;

  const stillHere = await Child.find({ _id: { $in: known }, is_active: { $ne: false } })
    .select('_id').lean();
  const here = new Set(stillHere.map((c) => String(c._id)));
  const gone = known.filter((id) => !here.has(String(id)));
  if (!gone.length) return 0;

  const res = await ChildFaceReference.deleteMany({ child_id: { $in: gone } });
  return res.deletedCount || 0;
}

async function tick(now = new Date()) {
  const forgotten = await forgetDepartedChildren();
  if (!storage.isConfigured()) {
    return { deleted: 0, forgotten, skipped: 'storage not configured' };
  }

  const used = await usedBytes();
  const cap = await checkCap(used);

  const cutoff = cutoffDate(now);
  const due = await Photo.find({ date: { $lt: cutoff } })
    .select('key thumb_key date')
    .limit(MAX_PER_RUN)
    .lean();

  let deleted = 0;
  let failed = 0;

  for (const photo of due) {
    try {
      // Both variants. A thumbnail left behind is a file nobody can reach and
      // nobody is paying attention to, which is the worst kind to leave.
      await storage.deleteObject(photo.key);
      if (photo.thumb_key && photo.thumb_key !== photo.key) {
        await storage.deleteObject(photo.thumb_key);
      }
      await Photo.deleteOne({ _id: photo._id });
      deleted += 1;
    } catch (err) {
      // The row survives a storage error on purpose: it is the only record
      // that these bytes exist, and dropping it would orphan them forever.
      failed += 1;
      console.error('[photo-retention] could not remove', photo._id, err.message);
    }
  }

  const remaining = deleted === MAX_PER_RUN
    ? await Photo.countDocuments({ date: { $lt: cutoff } })
    : 0;

  return {
    deleted, failed, cutoff, remaining, cap, stored: used.count, forgotten,
  };
}

function describeTick(r) {
  const out = [];
  if (r.forgotten) {
    out.push({
      level: 'log',
      text: `[photo-retention] dropped face templates for ${r.forgotten} children who have left`,
    });
  }
  if (r.deleted) {
    out.push({
      level: 'log',
      text: `[photo-retention] removed ${r.deleted} photographs older than ${r.cutoff}`
        + (r.remaining ? ` (${r.remaining} still due, capped at ${MAX_PER_RUN}/run)` : ''),
    });
  }
  if (r.failed) {
    out.push({ level: 'error', text: `[photo-retention] ${r.failed} could not be removed from storage` });
  }
  if (r.cap && r.cap.over) {
    out.push({
      level: 'error',
      text: `[photo-retention] photographs use ${r.cap.used_gb}GB, over the ${r.cap.cap_gb}GB ceiling `
        + '(nothing is deleted for that reason)',
    });
  }
  return out;
}

module.exports = {
  tick, describeTick, cutoffDate, usedBytes, forgetDepartedChildren,
  EVERY_MS, FIRST_RUN_MS, MAX_PER_RUN, CAP_KEY, DEFAULT_CAP_GB,
};
