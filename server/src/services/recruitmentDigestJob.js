const { Candidate, Branch, Setting, User } = require('../models');
const { dispatchEmail } = require('./email.service');
const recruitment = require('./recruitment.service');

/**
 * The 10:00 digest.
 *
 * The screen is the truth and the mail is the push. A manager who is not
 * expecting anybody will not open a recruitment tab on the off-chance, and an
 * applicant who waits three days for a call has usually taken another job — so
 * something has to reach her without her going to look.
 *
 * NO MAIL WHEN THERE IS NOTHING. A daily message that is usually empty trains
 * people to stop opening it, and then the one that matters is not opened
 * either.
 *
 * The tick is hourly and self-limiting: it does nothing before 10:00 and
 * nothing once today's has gone. That way a deploy or a restart at 10:04 does
 * not skip the day, and a second instance cannot send it twice.
 */

const SEND_HOUR = 10;
const SENT_KEY = 'recruitment_digest_last_sent';
/** Matches STALE_HOURS in the controller — the office's escalation line. */
const STALE_HOURS = 48;

/** Today in Israel, as YYYY-MM-DD — the send is a calendar-day event. */
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

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const day = (d) => (d ? new Date(d).toLocaleDateString('he-IL') : '');

function table(rows, { showWaiting = false } = {}) {
  const head = ['שם', 'טלפון', 'סניף מבוקש', 'הגיע/ה', showWaiting ? 'ממתין/ה' : 'מצב'];
  return `<table cellpadding="8" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;font-size:14px">
  <tr style="background:#f3f4f6">${head.map(h => `<th align="right" style="border-bottom:1px solid #e5e7eb">${h}</th>`).join('')}</tr>
  ${rows.map(c => `<tr>
    <td align="right" style="border-bottom:1px solid #f3f4f6"><b>${esc(c.full_name)}</b></td>
    <td align="right" style="border-bottom:1px solid #f3f4f6" dir="ltr">${esc(c.phone_raw || c.phone)}</td>
    <td align="right" style="border-bottom:1px solid #f3f4f6">${esc(c.requested_branch)}</td>
    <td align="right" style="border-bottom:1px solid #f3f4f6">${day(c.applications?.[c.applications.length - 1]?.at || c.created_at)}</td>
    <td align="right" style="border-bottom:1px solid #f3f4f6">${esc(
    showWaiting
      ? `${Math.floor((Date.now() - new Date(c.next_action_at).getTime()) / 3600000)} שעות`
      : ({ new: 'חדש/ה', no_answer: `לא ענה/תה (${(c.attempts || []).length})`, not_relevant: 'לשיחה חוזרת' }[c.status] || c.status),
  )}</td>
  </tr>`).join('')}
</table>`;
}

function page(title, intro, body) {
  return `<div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;color:#111827;max-width:680px">
  <h2 style="margin:0 0 4px">${esc(title)}</h2>
  <p style="margin:0 0 16px;color:#6b7280;font-size:14px">${esc(intro)}</p>
  ${body}
  <p style="margin-top:20px;font-size:13px;color:#6b7280">
    הפעולות — זימון לראיון, לא רלוונטי, לא ענה — נמצאות במסך הגיוס במערכת.
  </p>
</div>`;
}

/** Everyone a manager still has to call, for the branches she holds. */
function dueFilter(branchIds) {
  return {
    branch_ids: { $in: branchIds },
    status: { $in: ['new', 'no_answer', 'not_relevant'] },
    next_action_at: { $lte: new Date() },
  };
}

/** The office: whoever has network-wide sight. */
async function officeRecipients() {
  const setting = await Setting.findOne({ key: 'accountant_email' }).lean();
  const admins = await User.find({ role: { $in: ['system_admin', 'accountant'] }, is_active: true })
    .select('email').lean();
  const all = [setting?.value, ...admins.map(a => a.email)]
    .map(e => String(e || '').trim().toLowerCase())
    .filter(e => e.includes('@'));
  return [...new Set(all)];
}

/**
 * Build and send. Returns what it did, so the manual trigger can report it.
 *
 * @param {boolean} dryRun  compose and count, send nothing
 */
async function send({ dryRun = false } = {}) {
  const sent = [];

  const branches = await Branch.find({}).select('name').lean();
  const branchNames = new Map(branches.map(b => [String(b._id), b.name]));
  const emailSetting = await Setting.findOne({ key: 'branch_manager_emails' }).lean();
  const managerEmails = emailSetting?.value || {};

  // One mail per ADDRESS, not per branch. קפלן and משה דיין share a manager
  // and a mailbox; two mails landing a second apart, each holding half of her
  // morning, is how a list stops being read.
  const byAddress = new Map();
  for (const b of branches) {
    const address = String(managerEmails[String(b._id)] || '').trim().toLowerCase();
    if (!address.includes('@')) continue;
    if (!byAddress.has(address)) byAddress.set(address, []);
    byAddress.get(address).push(b._id);
  }

  for (const [address, branchIds] of byAddress) {
    const rows = await Candidate.find(dueFilter(branchIds)).sort({ next_action_at: 1 }).lean();
    if (!rows.length) continue;
    const names = branchIds.map(id => branchNames.get(String(id))).filter(Boolean).join(' · ');
    const html = page(
      `${rows.length} מועמדים ממתינים לשיחה`,
      `${names} · ${new Date().toLocaleDateString('he-IL')}`,
      table(rows),
    );
    if (!dryRun) {
      await dispatchEmail({ to: address, subject: `גיוס עובדים — ${rows.length} ממתינים לשיחה`, html });
    }
    sent.push({ to: address, branches: names, count: rows.length });
  }

  // The office gets what belongs to nobody, plus what a manager has left
  // sitting. Both are the same complaint — a person waiting for a call that
  // nobody is going to make — so they travel in one mail.
  const unassigned = await Candidate.find({
    branch_ids: { $size: 0 },
    status: { $in: ['new', 'no_answer', 'not_relevant'] },
    next_action_at: { $lte: new Date() },
  }).sort({ next_action_at: 1 }).lean();

  const stale = await Candidate.find({
    branch_ids: { $not: { $size: 0 } },
    status: 'new',
    next_action_at: { $lte: new Date(Date.now() - STALE_HOURS * 3600000) },
  }).sort({ next_action_at: 1 }).lean();

  if (unassigned.length || stale.length) {
    const parts = [];
    if (unassigned.length) {
      parts.push(`<h3 style="margin:16px 0 6px">${unassigned.length} ללא שיוך לסניף</h3>
        <p style="margin:0 0 8px;color:#6b7280;font-size:13px">בחרו "מענה כללי" או שהסניף לא זוהה — צריך להפנות למנהל/ת הרלוונטי/ת.</p>
        ${table(unassigned)}`);
    }
    if (stale.length) {
      parts.push(`<h3 style="margin:20px 0 6px">${stale.length} ממתינים מעל ${STALE_HOURS} שעות</h3>
        <p style="margin:0 0 8px;color:#6b7280;font-size:13px">שויכו לסניף ואיש לא יצר קשר.</p>
        ${table(stale, { showWaiting: true })}`);
    }
    const to = await officeRecipients();
    if (to.length) {
      const html = page('גיוס עובדים — לטיפול המשרד', new Date().toLocaleDateString('he-IL'), parts.join(''));
      if (!dryRun) {
        await dispatchEmail({ to, subject: `גיוס עובדים — ${unassigned.length + stale.length} לטיפול המשרד`, html });
      }
      sent.push({ to: to.join(', '), branches: 'משרד', count: unassigned.length + stale.length });
    }
  }

  return { sent, total: sent.reduce((n, s) => n + s.count, 0) };
}

/**
 * The hourly tick. Pulls first — a digest built before the morning's
 * applications are in is a digest that is wrong by the time it is read.
 */
async function tick(trigger = 'schedule') {
  const now = new Date();
  const key = todayKey(now);

  if (trigger === 'schedule') {
    if (hourInIsrael(now) < SEND_HOUR) return { skipped: 'before 10:00' };
    const last = await Setting.findOne({ key: SENT_KEY }).lean();
    if (last?.value === key) return { skipped: 'already sent today' };
  }

  let pulled = null;
  try {
    pulled = await recruitment.pullFromMailSorter();
  } catch (e) {
    // A digest of what is already here beats no digest at all.
    console.error('[recruitment] pull failed:', e.message);
  }

  const result = await send();

  if (trigger === 'schedule') {
    await Setting.findOneAndUpdate({ key: SENT_KEY }, { $set: { value: key } }, { upsert: true });
  }
  return { ...result, pulled };
}

module.exports = { tick, send, todayKey, SEND_HOUR, STALE_HOURS };
