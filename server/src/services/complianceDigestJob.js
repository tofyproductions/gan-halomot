const {
  BranchCertification, EmployeeCourse, Employee, Branch, Setting, User,
} = require('../models');
const { dispatchEmail } = require('./email.service');
const { CERT_TYPES, COURSE_TYPES, statusOf, daysLeft, WARN_DAYS } = require('./compliance');

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
      type: COURSE_TYPES[c.course_type] || c.course_type,
      expires_at: c.expires_at,
      status: statusOf(c.expires_at, now),
    }));

  return { dueCerts, dueCourses };
}

/** What the digest is about, reduced to a change key. */
function hashOf({ dueCerts, dueCourses }) {
  return JSON.stringify([
    dueCerts.map(c => [c.branch, c.type, c.status]),
    dueCourses.map(c => [c.employee, c.type, c.status]),
  ]);
}

async function recipients() {
  const [setting, admins] = await Promise.all([
    Setting.findOne({ key: RECIPIENTS_KEY }).lean(),
    User.find({ role: { $in: ['system_admin', 'accountant'] }, is_active: true })
      .select('email').lean(),
  ]);
  const extra = Array.isArray(setting?.value) ? setting.value : [];
  const all = [...extra, ...admins.map(a => a.email)]
    .map(e => String(e || '').trim().toLowerCase())
    .filter(e => e.includes('@'));
  return [...new Set(all)];
}

/** Build and send. Returns what it did, so a manual trigger can report it. */
async function send({ dryRun = false } = {}) {
  const now = new Date();
  const data = await collect(now);
  const { dueCerts, dueCourses } = data;
  if (!dueCerts.length && !dueCourses.length) return { sent: false, empty: true };

  const parts = [];
  if (dueCerts.length) {
    parts.push(`<h3 style="margin:8px 0 6px">אישורי מעון — ${dueCerts.length} לטיפול</h3>
      ${rowsTable(['סניף', 'אישור', 'תוקף', 'מצב'], dueCerts.map(c => [
    c.branch, c.type, day(c.expires_at),
    c.status === 'expired' ? `⛔ ${whenText(c.expires_at)}` : `⚠️ ${whenText(c.expires_at)}`,
  ]))}`);
  }
  if (dueCourses.length) {
    parts.push(`<h3 style="margin:20px 0 6px">קורסים של עובדות — ${dueCourses.length} לטיפול</h3>
      <p style="margin:0 0 8px;color:#6b7280;font-size:13px">עובדות שפג או עומד לפוג להן תוקף — אפשר לרכז אותן לקורס אחד.</p>
      ${rowsTable(['עובדת', 'סניף', 'קורס', 'תוקף', 'מצב'], dueCourses.map(c => [
    c.employee, c.branch, c.type, day(c.expires_at),
    c.status === 'expired' ? `⛔ ${whenText(c.expires_at)}` : `⚠️ ${whenText(c.expires_at)}`,
  ]))}`);
  }

  const total = dueCerts.length + dueCourses.length;
  const html = `<div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;color:#111827;max-width:680px">
  <h2 style="margin:0 0 4px">אישורים וקורסים — ${total} לטיפולך</h2>
  <p style="margin:0 0 16px;color:#6b7280;font-size:14px">${new Date().toLocaleDateString('he-IL')} · התראה נשלחת ${WARN_DAYS} ימים מראש</p>
  ${parts.join('')}
  <p style="margin-top:20px;font-size:13px;color:#6b7280">
    העלאת אישור מחודש נעשית במסכי "אישורי מעון" ו"קורסים והכשרות" במערכת.
  </p>
</div>`;

  const to = await recipients();
  if (!to.length) return { sent: false, no_recipients: true, total };
  if (!dryRun) {
    await dispatchEmail({ to, subject: `אישורים וקורסים — ${total} לטיפולך`, html });
  }
  return { sent: true, to, total, hash: hashOf(data) };
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

module.exports = { tick, send, collect, hashOf, SEND_HOUR, WARN_DAYS };
