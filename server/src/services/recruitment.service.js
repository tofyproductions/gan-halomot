const { Candidate, Branch } = require('../models');
const mailSorter = require('./mailSorter.service');

/**
 * Turning applications into candidates.
 *
 * The only thing in this file that knows where an application came from is
 * `pullFromMailSorter`. Everything else takes a plain {name, phone, branch}
 * and is what the in-house form will call directly once it exists.
 */

/**
 * A phone as an identity: digits, Israeli local form.
 *
 * 0544487880, 054-448-7880, +972544487880 and 972544487880 are one person, and
 * they will all four occur — the form is typed by hand and mail-sorter passes
 * through whatever was typed.
 */
function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('972')) d = `0${d.slice(3)}`;
  if (d.length === 9 && d.startsWith('5')) d = `0${d}`;
  return d;
}

/** The applicant chose "no particular gan" — the office routes these. */
const OFFICE_LABELS = ['משרד', 'מענה כללי', 'לא סגור', 'כללי'];

const squash = (s) => String(s || '').replace(/["'׳״]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Which branches a form label means.
 *
 * The form's list and this system's branches are deliberately different lists:
 * an applicant picks a town, and a town can hold two gans. "כפר סבא" is both
 * קפלן and משה דיין, and resolving it to both is not a fudge — the applicant
 * said כפר סבא and meant it, and one manager holds both anyway.
 *
 * Containment in either direction, because the form is the shorter name
 * ("הרצליה" against "הרצליה הרצוג") and could one day be the longer one.
 *
 * @returns {{ branch_ids: string[], office: boolean, unmatched: boolean }}
 */
function resolveBranches(label, branches) {
  const want = squash(label);
  if (!want) return { branch_ids: [], office: true, unmatched: false };
  if (OFFICE_LABELS.some(o => want.includes(o))) {
    return { branch_ids: [], office: true, unmatched: false };
  }
  const hits = branches.filter((b) => {
    const name = squash(b.name);
    return name === want || name.includes(want) || want.includes(name);
  });
  // No match is NOT the office. It is a branch nobody taught this system about
  // — a gan that opened after the form was written, or a typo — and it needs
  // somebody to look, which is what the flag is for.
  if (!hits.length) return { branch_ids: [], office: true, unmatched: true };
  return { branch_ids: hits.map(b => b._id), office: false, unmatched: false };
}

/** Two years from now — the retention floor, extended by a later callback. */
function retentionFrom(date = new Date(), notBefore = null) {
  const two = new Date(date);
  two.setFullYear(two.getFullYear() + 2);
  if (notBefore && new Date(notBefore) > two) return new Date(notBefore);
  return two;
}

/**
 * File one application against the person who made it.
 *
 * Creating and returning are the same operation on purpose. Somebody who was
 * archived after three unanswered calls and then applies again of their own
 * accord is the clearest possible signal that they still want the job, and
 * leaving them buried because of calls they missed would be the system
 * outsmarting itself. A fresh application puts them back on the screen.
 *
 * @returns {{ candidate, created: boolean, reopened: boolean }}
 */
async function intake({
  full_name, phone, requested_branch, message = '', at = new Date(),
  source = 'mail_sorter', source_ref = '', raw_subject = '',
}, branches) {
  const key = normalizePhone(phone);
  if (!key) return { candidate: null, created: false, reopened: false };

  const { branch_ids, unmatched } = resolveBranches(requested_branch, branches);
  const application = {
    at, source, source_ref, requested_branch: String(requested_branch || ''),
    raw_subject, message: message || '',
  };

  const existing = await Candidate.findOne({ phone: key });
  if (!existing) {
    const candidate = await Candidate.create({
      full_name: String(full_name || '').trim() || 'ללא שם',
      phone: key,
      phone_raw: String(phone || ''),
      branch_ids,
      requested_branch: String(requested_branch || ''),
      branch_unmatched: unmatched,
      status: 'new',
      next_action_at: at,
      applications: [application],
      events: [{ at, type: 'applied', note: String(requested_branch || '') }],
      retain_until: retentionFrom(at),
    });
    return { candidate, created: true, reopened: false };
  }

  // Seen this exact message before — mail-sorter serves its whole history on
  // every call, so this is the normal path, not an error.
  if (source_ref && existing.applications.some(a => a.source_ref === source_ref)) {
    return { candidate: existing, created: false, reopened: false };
  }

  const wasClosed = ['archived', 'not_relevant'].includes(existing.status);
  existing.applications.push(application);
  existing.events.push({ at, type: wasClosed ? 'reapplied' : 'applied', note: String(requested_branch || '') });
  // A later application says where they want to work now, so it wins.
  existing.requested_branch = String(requested_branch || existing.requested_branch);
  if (branch_ids.length) existing.branch_ids = branch_ids;
  existing.branch_unmatched = unmatched;
  if (String(full_name || '').trim()) existing.full_name = String(full_name).trim();
  if (wasClosed) {
    existing.status = 'new';
    existing.next_action_at = at;
    existing.close_reason = '';
    existing.future_relevant = false;
    existing.attempts = [];
  }
  existing.retain_until = retentionFrom(at, existing.retain_until);
  await existing.save();
  return { candidate: existing, created: false, reopened: wasClosed };
}

/**
 * Read the recruitment queue out of mail-sorter and file what is there.
 *
 * Deliberately does NOT ack. mail-sorter's ack suits a ledger that files a
 * document once; here the phone number is what prevents rework, and an item
 * that disappeared on first fetch could never be re-read after a fix on this
 * side. `all=1` plus the source_ref check above is the same guarantee, kept
 * where it can be reasoned about.
 *
 * Items with no parsed name or phone are CV attachments — a separate item with
 * no fields on it. They are counted and left alone; see Candidate.attachments.
 */
async function pullFromMailSorter() {
  if (!mailSorter.isConfigured()) {
    return { configured: false, created: 0, reopened: 0, seen: 0, files: 0 };
  }
  const payload = await mailSorter.listDocuments('recruitment');
  const items = Array.isArray(payload) ? payload : (payload?.items || payload?.documents || []);
  const branches = await Branch.find({}).select('name').lean();

  let created = 0; let reopened = 0; let files = 0;
  for (const item of items) {
    const ex = item.extracted || {};
    if (!ex.name || !ex.phone) { files += 1; continue; }
    const res = await intake({
      full_name: ex.name,
      phone: ex.phone,
      requested_branch: ex.branch,
      message: ex.message || '',
      at: item.received_at || item.created_at || new Date(),
      source: 'mail_sorter',
      source_ref: String(item.id ?? item._id ?? ''),
      raw_subject: ex.raw_subject || item.subject || '',
    }, branches);
    if (res.created) created += 1;
    if (res.reopened) reopened += 1;
  }
  return { configured: true, created, reopened, seen: items.length, files };
}

module.exports = {
  normalizePhone, resolveBranches, retentionFrom, intake, pullFromMailSorter, OFFICE_LABELS,
};
