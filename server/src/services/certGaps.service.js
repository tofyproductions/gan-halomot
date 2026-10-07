const { BranchCertification, Branch } = require('../models');
const { CERT_TYPES, REQUIRED_CERT_TYPES, statusOf } = require('./compliance');

/**
 * מה חסר בתיק האישורים — and the weekly nudge to the person who fills it.
 *
 * Computation only — the sending lives in complianceDigestJob, which already
 * mails the office and עינת weekly. A second weekly mail about the same folder
 * would be two mails to ignore instead of one to read.
 *
 * The screen already shows what a branch HOLDS. The thing nobody can see by
 * looking is what it does not hold: an אישור בודק בטיחות that was never
 * uploaded is an empty space on a page, and an empty space does not announce
 * itself. So "missing" is computed against REQUIRED_CERT_TYPES and said out
 * loud, per branch.
 *
 * THREE KINDS OF GAP, and they are different problems:
 *   missing     — no row at all. Somebody has to find the paper.
 *   expired     — a row whose date has passed. Somebody has to renew it.
 *   no_expiry   — a row with a file and NO expiry date. This is the quiet one:
 *                 the certificate is there, the screen looks green, and the
 *                 digest will never warn because there is no date to warn
 *                 about. Most of the imported ones are in this state, since
 *                 filenames do not carry an expiry.
 */

/**
 * Every gap, per branch.
 *
 * Only live rows count. An archived certificate is last year's and does not
 * cover this year, which is the whole reason renewal archives instead of
 * overwriting.
 */
async function gaps({ branchIds = null } = {}) {
  const branchFilter = Array.isArray(branchIds) ? { _id: { $in: branchIds } } : {};
  const branches = await Branch.find({ ...branchFilter, is_active: { $ne: false } })
    .select('name').sort({ name: 1 }).lean();
  if (branches.length === 0) return [];

  const certs = await BranchCertification.find({
    branch_id: { $in: branches.map(b => b._id) },
    is_archived: false,
  }).select('branch_id cert_type expires_at external_url file_data').lean();

  const now = new Date();
  const out = [];
  for (const b of branches) {
    const mine = certs.filter(c => String(c.branch_id) === String(b._id));
    const missing = [];
    const expired = [];
    const noExpiry = [];

    for (const type of REQUIRED_CERT_TYPES) {
      const rows = mine.filter(c => c.cert_type === type);
      if (rows.length === 0) { missing.push(type); continue; }
      // Of several of one type, the best one decides: a branch that holds a
      // valid certificate is covered even if an older one beside it has
      // lapsed.
      const states = rows.map(r => statusOf(r.expires_at, now));
      if (states.includes('ok') || states.includes('expiring')) continue;
      if (states.every(s => s === 'no_expiry')) noExpiry.push(type);
      else expired.push(type);
    }

    out.push({
      branch_id: String(b._id),
      branch_name: b.name,
      missing,
      expired,
      no_expiry: noExpiry,
      total_gaps: missing.length + expired.length + noExpiry.length,
      required_count: REQUIRED_CERT_TYPES.length,
    });
  }
  return out;
}

/** The reminder's words. Built once and used by both the push and the mail. */
function describe(list) {
  const lines = [];
  for (const b of list) {
    if (b.total_gaps === 0) continue;
    const parts = [];
    const names = (keys) => keys.map(k => CERT_TYPES[k] || k).join(', ');
    if (b.missing.length) parts.push(`חסרים: ${names(b.missing)}`);
    if (b.expired.length) parts.push(`פגי תוקף: ${names(b.expired)}`);
    if (b.no_expiry.length) parts.push(`בלי תאריך תפוגה: ${names(b.no_expiry)}`);
    lines.push(`${b.branch_name} — ${parts.join(' · ')}`);
  }
  return lines;
}

module.exports = { gaps, describe };
