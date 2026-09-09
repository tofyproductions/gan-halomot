const { Branch, User, Setting } = require('../models');
const { dispatchEmail } = require('./email.service');
const { enrollmentYear, formatAcademicYear } = require('./academic-year.service');
const { buildReconciliation, isTmtSupervised } = require('../controllers/tmtApproval.controller');

/**
 * שכבת גיל שונה — the one finding on the תמ"ת↔קליקטאק comparison marked
 * urgent (see ISSUES.age_group_mismatch in enrollment-reconcile.service): the
 * ministry funds a child at one bracket and ClickTac has them at another, and
 * one side is being billed or reported wrong until somebody fixes it. Nobody
 * reads this screen daily on their own, so this mails whoever fixes it —
 * every morning there is at least one open — until it is closed.
 *
 * "Open" already means what the screen means: `buildReconciliation` filters
 * out anything a person resolved on the child's card and puts back only what
 * a later upload actually reopened (see `resolved_issues` / `snapshotFor` in
 * enrollment-reconcile.service). This job does not re-derive that; it reads
 * the same rows the screen would show and asks which ones are still marked
 * `urgent`.
 *
 * Sent when the LIST CHANGES (a child added, fixed, or moved branch) or once
 * a week (Sunday) regardless — same rule as the compliance digest, for the
 * same reason: an unchanging problem must not turn into wallpaper, and a
 * silent month must still say once that the silence is real.
 */

const SEND_HOUR = 9;
const SENT_KEY = 'reconcile_urgent_digest_last_sent';
const HASH_KEY = 'reconcile_urgent_digest_last_hash';
const RECIPIENTS_KEY = 'reconcile_alert_emails';

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

/**
 * Every open, urgent row, across every ministry-supervised branch, for the
 * current intake year.
 */
async function collect() {
  const year = enrollmentYear();
  const branches = await Branch.find({ is_active: { $ne: false } }).select('name tmt_supervised').lean();
  const supervised = branches.filter(isTmtSupervised);

  const found = [];
  for (const branch of supervised) {
    // eslint-disable-next-line no-await-in-loop
    const { result, error } = await buildReconciliation({ branchId: branch._id, academicYear: year });
    if (error || !result) continue;
    for (const row of result.rows) {
      if (!row.urgent) continue;
      const issue = row.issues.find(i => i.code === 'age_group_mismatch');
      found.push({
        branch: branch.name,
        child_name: row.child_name,
        id_number: row.id_number,
        detail: issue?.detail || '',
      });
    }
  }
  found.sort((a, b) => a.branch.localeCompare(b.branch, 'he') || a.child_name.localeCompare(b.child_name, 'he'));
  return { year, rows: found };
}

function hashOf({ rows }) {
  return JSON.stringify(rows.map(r => [r.branch, r.id_number, r.detail]));
}

async function recipients() {
  const [setting, admins] = await Promise.all([
    Setting.findOne({ key: RECIPIENTS_KEY }).lean(),
    User.find({ role: { $in: ['system_admin', 'accountant'] }, is_active: { $ne: false } })
      .select('email').lean(),
  ]);
  const extra = Array.isArray(setting?.value) ? setting.value : [];
  const all = [...extra, ...admins.map(a => a.email)]
    .map(e => String(e || '').trim().toLowerCase())
    .filter(e => e.includes('@'));
  return [...new Set(all)];
}

function rowsTable(rows) {
  return `<table cellpadding="8" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;font-size:14px">
  <tr style="background:#f3f4f6">
    <th align="right" style="border-bottom:1px solid #e5e7eb">סניף</th>
    <th align="right" style="border-bottom:1px solid #e5e7eb">ילד/ה</th>
    <th align="right" style="border-bottom:1px solid #e5e7eb">ת"ז</th>
    <th align="right" style="border-bottom:1px solid #e5e7eb">פירוט</th>
  </tr>
  ${rows.map(r => `<tr>
    <td style="border-bottom:1px solid #f3f4f6">${esc(r.branch)}</td>
    <td style="border-bottom:1px solid #f3f4f6"><b>${esc(r.child_name)}</b></td>
    <td style="border-bottom:1px solid #f3f4f6">${esc(r.id_number)}</td>
    <td style="border-bottom:1px solid #f3f4f6">${esc(r.detail)}</td>
  </tr>`).join('')}
</table>`;
}

/** Build and send. Returns what it did, so a manual trigger can report it. */
async function send({ dryRun = false } = {}) {
  const data = await collect();
  if (!data.rows.length) return { sent: false, empty: true };

  const html = `<div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;color:#111827;max-width:680px">
  <h2 style="margin:0 0 4px">שכבת גיל שונה — ${data.rows.length} לטיפול</h2>
  <p style="margin:0 0 16px;color:#6b7280;font-size:14px">
    ${new Date().toLocaleDateString('he-IL')} · שנת ${formatAcademicYear(data.year)} ·
    שכבת הגיל בתמ"ת ובקליקטאק אינה תואמת — לתקן באחד הקבצים או לסמן "בדקתי — תקין" במסך ההצלבה
  </p>
  ${rowsTable(data.rows)}
  <p style="margin-top:20px;font-size:13px;color:#6b7280">
    מסך ההצלבה: רישום חיצוני ← הצלבת תמ"ת מול קליקטאק.
  </p>
</div>`;

  const to = await recipients();
  if (!to.length) return { sent: false, no_recipients: true, total: data.rows.length };
  if (!dryRun) {
    try {
      await dispatchEmail({ to, subject: `שכבת גיל שונה — ${data.rows.length} לטיפול`, html });
    } catch (err) {
      return { sent: false, error: err.message, to, total: data.rows.length };
    }
  }
  return { sent: true, to, total: data.rows.length, hash: hashOf(data) };
}

/** The hourly tick — same change-or-Sunday rule as the compliance digest. */
async function tick(trigger = 'schedule') {
  const now = new Date();
  const key = todayKey(now);

  if (trigger === 'schedule') {
    if (hourInIsrael(now) < SEND_HOUR) return { skipped: 'before send hour' };
    const last = await Setting.findOne({ key: SENT_KEY }).lean();
    if (last?.value === key) return { skipped: 'already sent today' };

    const data = await collect();
    if (!data.rows.length) return { skipped: 'nothing urgent' };
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

module.exports = { tick, send, collect, hashOf, RECIPIENTS_KEY };
