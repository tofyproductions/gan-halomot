const {
  BranchCertification, EmployeeCourse, Employee, Branch, Setting, User,
} = require('../models');
const { dispatchEmail } = require('./email.service');
const { CERT_TYPES, COURSE_TYPES, statusOf, daysLeft, WARN_DAYS } = require('./compliance');
const certGaps = require('./certGaps.service');
const { branchManagerFilter, mailableManagerEmails } = require('./branch-recipients.service');

/**
 * The expiry digest — אישורי מעון and קורסים in one morning mail.
 *
 * A certificate that expires in two months is not news two months running, so
 * a plain daily send would train everybody to delete it. This one goes out
 * when the LIST CHANGES — something newly expiring, newly expired, renewed and
 * gone — and once a week (Sunday) regardless, so a quiet month still gets its
 * reminder that the quiet is real.
 *
 * Recipients: the office (system_admin + accountant users) plus whoever is in
 * the compliance_alert_emails setting — that list is where עינת lives if she
 * has no user account.
 *
 * IT ALSO CARRIES WHAT IS NOT THERE. A certificate that expires can be mailed
 * about because there is a row to look at; one that was never uploaded cannot,
 * and an empty space on a page does not announce itself. So the digest now
 * opens with the gaps — a required certificate with no row at all, and the
 * quieter case of a row with a FILE AND NO EXPIRY DATE, which looks green on
 * the screen and will never reach this mail on its own because there is no
 * date to compare. Most of the certificates imported out of Drive start in
 * exactly that state, because filenames do not carry an expiry.
 */

const SEND_HOUR = 9;
const SENT_KEY = 'compliance_digest_last_sent';
const HASH_KEY = 'compliance_digest_last_hash';
const RECIPIENTS_KEY = 'compliance_alert_emails';

function todayKey(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

function hourInIsrael(now = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false,
  }).format(now));
}

function weekdayInIsrael(now = new Date()) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', weekday: 'short' }).format(now);
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const day = (d) => (d ? new Date(d).toLocaleDateString('he-IL') : '—');

/** "פג לפני 12 יום" / "בעוד 5 ימים" — what the reader actually wants to know. */
function whenText(expiresAt) {
  const n = daysLeft(expiresAt);
  if (n == null) return 'ללא תאריך תוקף';
  if (n < 0) return `פג לפני ${-n} ימים`;
  if (n === 0) return 'פג היום';
  return `בעוד ${n} ימים`;
}

function rowsTable(head, rows) {
  return `<table cellpadding="8" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;font-size:14px">
  <tr style="background:#f3f4f6">${head.map(h => `<th align="right" style="border-bottom:1px solid #e5e7eb">${esc(h)}</th>`).join('')}</tr>
  ${rows.map(cells => `<tr>${cells.map((c, i) => `<td align="right" style="border-bottom:1px solid #f3f4f6">${i === 0 ? `<b>${esc(c)}</b>` : esc(c)}</td>`).join('')}</tr>`).join('')}
</table>`;
}

/** Everything currently expired or inside the warning window. */
async function collect(now = new Date()) {
  const [certs, courses, branches] = await Promise.all([
    BranchCertification.find({ is_archived: false }).select('-file_data').lean(),
    EmployeeCourse.find({ is_archived: false, expires_at: { $ne: null } }).select('-file_data').lean(),
    Branch.find({}).select('name').lean(),
  ]);
  const branchNames = new Map(branches.map(b => [String(b._id), b.name]));

  const dueCerts = certs
    .filter(c => ['expired', 'expiring'].includes(statusOf(c.expires_at, now)))
    .sort((a, b) => new Date(a.expires_at) - new Date(b.expires_at))
    .map(c => ({
      branch: branchNames.get(String(c.branch_id)) || '?',
      type: c.cert_type === 'other' ? (c.label || 'אחר') : (CERT_TYPES[c.cert_type] || c.cert_type),
      expires_at: c.expires_at,
      status: statusOf(c.expires_at, now),
    }));

  const dueCourseRows = courses
    .filter(c => ['expired', 'expiring'].includes(statusOf(c.expires_at, now)));
  const employees = await Employee.find({
    _id: { $in: dueCourseRows.map(c => c.employee_id) }, is_active: true,
  }).select('full_name branch_id phone').lean();
  const empById = new Map(employees.map(e => [String(e._id), e]));

  const dueCourses = dueCourseRows
    .map(c => ({ c, emp: empById.get(String(c.employee_id)) }))
    // An inactive employee's lapsed course is nobody's morning.
    .filter(x => x.emp)
    .sort((a, b) => new Date(a.c.expires_at) - new Date(b.c.expires_at))
    .map(({ c, emp }) => ({
      employee: emp.full_name,
      phone: emp.phone || '',
      branch: branchNames.get(String(emp.branch_id)) || '?',
      // Kept as an id too: the per-branch manager reminder groups by it.
      branch_id: emp.branch_id ? String(emp.branch_id) : null,
      type: COURSE_TYPES[c.course_type] || c.course_type,
      expires_at: c.expires_at,
      status: statusOf(c.expires_at, now),
    }));

  const gaps = (await certGaps.gaps()).filter(b => b.total_gaps > 0);

  return { dueCerts, dueCourses, gaps };
}

/** What the digest is about, reduced to a change key. */
function hashOf({ dueCerts, dueCourses, gaps = [] }) {
  return JSON.stringify([
    dueCerts.map(c => [c.branch, c.type, c.status]),
    dueCourses.map(c => [c.employee, c.type, c.status]),
    // A certificate uploaded — or one newly missing because a branch was added
    // — is a change, so the mail goes out rather than waiting for Sunday.
    gaps.map(b => [b.branch_name, b.missing, b.expired, b.no_expiry]),
  ]);
}

async function recipients() {
  const [setting, office] = await Promise.all([
    Setting.findOne({ key: RECIPIENTS_KEY }).lean(),
    require('./office-recipients.service').officeEmails('hr'),
  ]);
  const extra = Array.isArray(setting?.value) ? setting.value : [];
  const all = [...extra, ...office]
    .map(e => String(e || '').trim().toLowerCase())
    .filter(e => e.includes('@'));
  return [...new Set(all)];
}

/**
 * ריענוני קורסים — the reminder goes FIRST to the gan's own manager.
 *
 * The office report below lists every branch at once, which makes it
 * somebody-else's-list for each of them. So each branch's manager (הרצליה,
 * סניפי כפר סבא, תל אביב — whoever RUNS the branch per branch-recipients,
 * including an admin_viewer covering it) gets her own mail with only her
 * caregivers' refreshers, and the consolidated report still goes to the
 * office (עינת via the hr routing / compliance_alert_emails, and the system
 * admins as the never-silent fallback) in the same run.
 *
 * A manager without a real address falls back to the office with a notice
 * saying who the mail was meant for — the same rule every other branch mail
 * follows.
 */
async function sendBranchReminders(dueCourses, { dryRun = false } = {}) {
  const byBranch = new Map();
  for (const row of dueCourses) {
    if (!row.branch_id) continue; // no branch — office report only
    if (!byBranch.has(row.branch_id)) byBranch.set(row.branch_id, []);
    byBranch.get(row.branch_id).push(row);
  }

  const results = [];
  for (const [branchId, rows] of byBranch) {
    const branchName = rows[0].branch;
    const managers = await User.find(branchManagerFilter(branchId))
      .select('full_name email role managed_branch_ids branch_id').lean();
    const { to, notice, fell_back } = await mailableManagerEmails(managers, {
      what: 'תזכורת ריענוני קורסים', branchName,
    });
    if (!to.length) { results.push({ branch: branchName, to: [], count: rows.length, skipped: 'no recipients' }); continue; }

    const html = `<div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;color:#111827;max-width:680px">
  ${notice}
  <h2 style="margin:0 0 4px">ריענוני קורסים — ${esc(branchName)}</h2>
  <p style="margin:0 0 12px;color:#6b7280;font-size:14px">
    ${new Date().toLocaleDateString('he-IL')} · ${rows.length} עובדות לטיפולך · התראה נשלחת ${WARN_DAYS} ימים מראש
  </p>
  <p style="margin:0 0 8px;color:#374151">
    לעובדות הבאות פג או עומד לפוג תוקף הקורס. יש לתאם ריענון ולהעלות את התעודה
    המחודשת במסך "קורסים והכשרות". דוח מרוכז נשלח במקביל למשרד.
  </p>
  ${rowsTable(['עובדת', 'טלפון', 'קורס', 'תוקף', 'מצב'], rows.map(c => [
    c.employee, c.phone || '—', c.type, day(c.expires_at),
    c.status === 'expired' ? `⛔ ${whenText(c.expires_at)}` : `⚠️ ${whenText(c.expires_at)}`,
  ]))}
</div>`;

    if (!dryRun) {
      await dispatchEmail({
        to,
        subject: `ריענוני קורסים — ${branchName}: ${rows.length} לטיפולך`,
        html,
      });
    }
    results.push({ branch: branchName, to, count: rows.length, fell_back });
  }
  return results;
}

/** Build and send. Returns what it did, so a manual trigger can report it. */
async function send({ dryRun = false } = {}) {
  const now = new Date();
  const data = await collect(now);
  const { dueCerts, dueCourses, gaps = [] } = data;
  if (!dueCerts.length && !dueCourses.length && !gaps.length) return { sent: false, empty: true };

  // The managers first — each gan hears about its own caregivers.
  const branchMails = await sendBranchReminders(dueCourses, { dryRun });

  const parts = [];

  // First, because it is the part nobody can see by looking at the screen.
  if (gaps.length) {
    const totalGaps = gaps.reduce((t, b) => t + b.total_gaps, 0);
    parts.push(`<h3 style="margin:8px 0 6px">חסר בתיק אישורי המעון — ${totalGaps} פריטים</h3>
      <p style="margin:0 0 8px;color:#374151">יש להעלות את המסמכים האלה למערכת. כל עוד הם חסרים, ההודעה תחזור.</p>
      ${rowsTable(['סניף', 'מה חסר'], certGaps.describe(gaps).map((line) => {
        const [branch, rest] = line.split(' — ');
        return [branch, rest || ''];
      }))}`);
  }
  if (dueCerts.length) {
    parts.push(`<h3 style="margin:8px 0 6px">אישורי מעון — ${dueCerts.length} לטיפול</h3>
      ${rowsTable(['סניף', 'אישור', 'תוקף', 'מצב'], dueCerts.map(c => [
    c.branch, c.type, day(c.expires_at),
    c.status === 'expired' ? `⛔ ${whenText(c.expires_at)}` : `⚠️ ${whenText(c.expires_at)}`,
  ]))}`);
  }
  if (dueCourses.length) {
    const managersLine = branchMails.some(b => b.to.length && !b.fell_back)
      ? ' לכל מנהל/ת מעון נשלחה במקביל תזכורת עם העובדות של הסניף שלו/ה.' : '';
    parts.push(`<h3 style="margin:20px 0 6px">קורסים של עובדות — ${dueCourses.length} לטיפול</h3>
      <p style="margin:0 0 8px;color:#6b7280;font-size:13px">עובדות שפג או עומד לפוג להן תוקף — אפשר לרכז אותן לקורס אחד.${managersLine}</p>
      ${rowsTable(['עובדת', 'סניף', 'קורס', 'תוקף', 'מצב'], dueCourses.map(c => [
    c.employee, c.branch, c.type, day(c.expires_at),
    c.status === 'expired' ? `⛔ ${whenText(c.expires_at)}` : `⚠️ ${whenText(c.expires_at)}`,
  ]))}`);
  }

  // The gaps count too. A subject line reading "20 לטיפולך" above a mail that
  // opens with 32 missing certificates is a subject line nobody trusts again.
  const total = dueCerts.length + dueCourses.length
    + gaps.reduce((t, b) => t + b.total_gaps, 0);
  const html = `<div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;color:#111827;max-width:680px">
  <h2 style="margin:0 0 4px">אישורים וקורסים — ${total} לטיפולך</h2>
  <p style="margin:0 0 16px;color:#6b7280;font-size:14px">${new Date().toLocaleDateString('he-IL')} · התראה נשלחת ${WARN_DAYS} ימים מראש</p>
  ${parts.join('')}
  <p style="margin-top:20px;font-size:13px;color:#6b7280">
    העלאת אישור מחודש נעשית במסכי "אישורי מעון" ו"קורסים והכשרות" במערכת.
  </p>
</div>`;

  const to = await recipients();
  if (!to.length) return { sent: false, no_recipients: true, total, branch_mails: branchMails };
  if (!dryRun) {
    await dispatchEmail({ to, subject: `אישורים וקורסים — ${total} לטיפולך`, html });
  }
  return { sent: true, to, total, hash: hashOf(data), branch_mails: branchMails };
}

/**
 * The hourly tick. Sends when the list changed since the last send, or on
 * Sunday regardless — and at most once a day either way.
 */
async function tick(trigger = 'schedule') {
  const now = new Date();
  const key = todayKey(now);

  if (trigger === 'schedule') {
    if (hourInIsrael(now) < SEND_HOUR) return { skipped: 'before send hour' };
    const last = await Setting.findOne({ key: SENT_KEY }).lean();
    if (last?.value === key) return { skipped: 'already sent today' };

    const data = await collect(now);
    if (!data.dueCerts.length && !data.dueCourses.length) {
      // Nothing due — but a stale hash would fire a "change" the moment one
      // item appears, which is exactly what we want. Leave it.
      return { skipped: 'nothing due' };
    }
    const lastHash = await Setting.findOne({ key: HASH_KEY }).lean();
    const changed = lastHash?.value !== hashOf(data);
    const sunday = weekdayInIsrael(now) === 'Sun';
    if (!changed && !sunday) return { skipped: 'no change since last digest' };
  }

  const result = await send();
  if (result.sent) {
    await Setting.findOneAndUpdate({ key: SENT_KEY }, { $set: { value: key } }, { upsert: true });
    await Setting.findOneAndUpdate({ key: HASH_KEY }, { $set: { value: result.hash } }, { upsert: true });
  }
  return result;
}

module.exports = { tick, send, collect, hashOf, sendBranchReminders, SEND_HOUR, WARN_DAYS };
