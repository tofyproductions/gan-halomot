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

/**
 * One field out of an extracted record, whatever it is wrapped in.
 *
 * A parser may hand back "0544487880" or { value: "0544487880" }, and the
 * difference is invisible to a truthiness check: an object is truthy, and
 * String({}) is "[object Object]", which has no digits in it. That combination
 * silently discarded seventy-five real applicants — every test passed and
 * nobody was created.
 *
 * So a field is read rather than assumed, and anything that is still not a
 * scalar afterwards is reported as unreadable instead of being stringified
 * into nonsense.
 */
function pick(field) {
  if (field == null) return '';
  if (typeof field === 'string' || typeof field === 'number') return String(field).trim();
  if (typeof field === 'object') {
    for (const k of ['value', 'text', 'raw', 'content']) {
      if (typeof field[k] === 'string' || typeof field[k] === 'number') return String(field[k]).trim();
    }
  }
  return '';
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
async function pullFromMailSorter({ debug = false } = {}) {
  if (!mailSorter.isConfigured()) {
    return { configured: false, created: 0, reopened: 0, seen: 0, files: 0, skipped: {} };
  }
  const payload = await mailSorter.listDocuments('recruitment');
  const items = Array.isArray(payload) ? payload : (payload?.items || payload?.documents || []);
  const branches = await Branch.find({}).select('name').lean();

  let created = 0; let reopened = 0; let files = 0;
  /**
   * Why nothing happened, when nothing happens.
   *
   * The first real run read 125 items and created nobody, and the only thing
   * the screen could say was "0". A pull that declines every row has to be
   * able to say which test each row failed — otherwise the next person is
   * reduced to guessing at a payload they cannot see.
   */
  const skipped = { no_extracted: 0, no_name: 0, no_phone: 0, phone_unparsable: 0, already_known: 0 };

  for (const item of items) {
    const ex = item.extracted || item.fields || item.data || {};
    if (!Object.keys(ex).length) { skipped.no_extracted += 1; files += 1; continue; }
    const name = pick(ex.name);
    const phone = pick(ex.phone);
    if (!name) { skipped.no_name += 1; files += 1; continue; }
    if (!phone) { skipped.no_phone += 1; files += 1; continue; }
    if (!normalizePhone(phone)) { skipped.phone_unparsable += 1; continue; }

    const res = await intake({
      full_name: name,
      phone,
      requested_branch: pick(ex.branch),
      message: pick(ex.message),
      at: item.received_at || item.created_at || item.date || new Date(),
      source: 'mail_sorter',
      source_ref: String(item.id ?? item._id ?? ''),
      raw_subject: pick(ex.raw_subject) || pick(item.subject),
    }, branches);
    if (res.created) created += 1;
    else if (res.reopened) reopened += 1;
    else skipped.already_known += 1;
  }

  const out = { configured: true, created, reopened, seen: items.length, files, skipped };

  /**
   * The shape, on request, as KEY NAMES ONLY.
   *
   * Enough to see where the fields actually live, and it cannot leak a phone
   * number or a name into a log or a screenshot on the way.
   */
  if (debug) {
    const shapeOf = (o) => (o && typeof o === 'object' ? Object.keys(o) : typeof o);
    const withEx = items.find(i => Object.keys(i.extracted || i.fields || i.data || {}).length);
    out.debug = {
      payload_type: Array.isArray(payload) ? 'array' : `object(${Object.keys(payload || {}).join(',')})`,
      item_keys: shapeOf(items[0]),
      extracted_keys: shapeOf(items[0]?.extracted ?? items[0]?.fields ?? items[0]?.data),
      first_with_fields_keys: withEx ? shapeOf(withEx.extracted || withEx.fields || withEx.data) : null,
      // Types only — never the values.
      field_types: withEx
        ? Object.fromEntries(Object.entries(withEx.extracted || withEx.fields || withEx.data)
          .map(([k, v]) => [k, v === null ? 'null' : typeof v]))
        : null,
    };
  }
  return out;
}

module.exports = {
  normalizePhone, resolveBranches, retentionFrom, intake, pullFromMailSorter, OFFICE_LABELS, pick,
};
