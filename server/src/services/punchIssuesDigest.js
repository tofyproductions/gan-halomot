'use strict';

const mongoose = require('mongoose');
const { Branch, Setting, User, NotificationEvent } = require('../models');
const { createEvent, branchManagerIds, accountantIds } = require('./notification.service');

/**
 * The morning punch-issues digest.
 *
 * Per-punch pushes already exist (punch_pending_manager/accountant nag until
 * the specific approval is handled). What they never covered is the WIDE
 * picture — the days with no punch at all, the duplicate days waiting for a
 * decision, the fixed-schedule conflicts — the things that block the
 * accountant's send at month's end and are cheapest to fix the morning after
 * they happen, while the manager still remembers who was actually there.
 *
 * So: once per morning (07:00 Israel, weekdays), every branch manager whose
 * branch carries open issues gets ONE push naming the counts, and the office
 * (admin + accounting) gets ONE network-wide summary. One push, not a nag:
 * the created event is immediately closed after its first delivery, so the
 * hourly resend loop never picks it up. Tomorrow's run pushes again only if
 * the branch is still dirty. The in-app banner (PunchIssuesBanner) is the
 * "opened the system" half of the same feature — live counts, one tap to the
 * fix screen.
 *
 * Wired in index.js as an hourly check under a job lease; `tick()` itself
 * decides whether it is time (past 07:00 IL, not yet run today) via a
 * Setting marker — so a restart at noon doesn't re-push, and the exact boot
 * hour never matters.
 */

const MARKER_KEY = 'punch_digest_last_run_day';
const DIGEST_HOUR_IL = 7;

function ilNowParts() {
  const now = new Date();
  const day = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }); // YYYY-MM-DD
  const hour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem', hour: 'numeric', hour12: false,
  }).format(now));
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem', weekday: 'short',
  }).format(now); // 'Sun'..'Sat'
  return { day, hour, weekday };
}

/** One line a human reads on a lock screen. Only the non-zero parts. */
function issueLine({ missing = 0, duplicates = 0, conflicts = 0 }) {
  const parts = [];
  if (missing) parts.push(`${missing} החתמות חסרות`);
  if (duplicates) parts.push(`${duplicates} ימים כפולים`);
  if (conflicts) parts.push(`${conflicts} קונפליקטים`);
  return parts.join(' · ');
}

/** Deliver one push per recipient, then close the event so resendDue never nags. */
async function pushOnce({ type, refId, recipientId, title, body, url }) {
  await createEvent({
    type, ref_collection: 'Branch', ref_id: refId, recipient_id: recipientId,
    title, body, url,
  });
  await NotificationEvent.updateMany(
    { type, ref_id: refId, recipient_id: recipientId, status: 'pending' },
    { $set: { status: 'resolved', resolved_at: new Date() } },
  );
}

async function tick() {
  const { day, hour, weekday } = ilNowParts();
  if (weekday === 'Sat') return { ran: false, why: 'shabbat' };
  if (hour < DIGEST_HOUR_IL) return { ran: false, why: 'early' };

  // Once per day, whatever hour the check happens to land on.
  const marker = await Setting.findOne({ key: MARKER_KEY }).lean();
  if (marker && marker.value === day) return { ran: false, why: 'already-ran' };
  await Setting.updateOne(
    { key: MARKER_KEY }, { $set: { value: day } }, { upsert: true },
  );

  // The same engine the issues screen runs on — never a second implementation.
  const { punchIssues, fixedScheduleConflicts } = require('../controllers/payrollMonth.controller');
  const month = day.slice(0, 7);
  const [{ duplicates = [], missing = [] }, conflicts] = await Promise.all([
    punchIssues(month),
    fixedScheduleConflicts(month, {}).catch(() => []),
  ]);

  // Group per branch.
  const perBranch = new Map(); // branchId → {missing, duplicates, conflicts}
  const bump = (list, field) => {
    for (const i of list) {
      const b = String(i.branch_id || '');
      if (!b) continue;
      if (!perBranch.has(b)) perBranch.set(b, { missing: 0, duplicates: 0, conflicts: 0 });
      perBranch.get(b)[field] += 1;
    }
  };
  bump(missing, 'missing');
  bump(duplicates, 'duplicates');
  bump(conflicts || [], 'conflicts');

  if (perBranch.size === 0) return { ran: true, branches: 0 };

  const branchDocs = await Branch.find({ _id: { $in: [...perBranch.keys()] } })
    .select('name').lean();
  const nameOf = new Map(branchDocs.map(b => [String(b._id), b.name]));

  // Branch managers — each gets their own branch's line.
  let managerPushes = 0;
  for (const [branchId, counts] of perBranch) {
    const managers = await branchManagerIds(branchId).catch(() => []);
    for (const uid of managers) {
      await pushOnce({
        type: 'punch_issues_digest',
        refId: new mongoose.Types.ObjectId(branchId),
        recipientId: uid,
        title: `בעיות החתמה — ${nameOf.get(branchId) || 'הסניף שלך'}`,
        body: `${issueLine(counts)} · לחצו לטיפול`,
        url: '/attendance?issues=1',
      });
      managerPushes += 1;
    }
  }

  // The office — one network-wide line for admins and accountants.
  const totals = [...perBranch.values()].reduce((a, c) => ({
    missing: a.missing + c.missing,
    duplicates: a.duplicates + c.duplicates,
    conflicts: a.conflicts + c.conflicts,
  }), { missing: 0, duplicates: 0, conflicts: 0 });
  const admins = await User.find({ role: 'system_admin', is_active: { $ne: false } })
    .select('_id').lean();
  const accountants = await accountantIds().catch(() => []);
  const officeIds = [...new Set([...admins.map(a => String(a._id)), ...accountants.map(String)])];
  // The ref for the office digest is the busiest branch — the field is only a
  // dedupe key here, and a real Branch id keeps the schema honest.
  const busiest = [...perBranch.entries()]
    .sort((a, b) => (b[1].missing + b[1].duplicates + b[1].conflicts)
      - (a[1].missing + a[1].duplicates + a[1].conflicts))[0][0];
  let officePushes = 0;
  for (const uid of officeIds) {
    await pushOnce({
      type: 'punch_issues_digest_office',
      refId: new mongoose.Types.ObjectId(busiest),
      recipientId: uid,
      title: `בעיות החתמה ברשת — ${perBranch.size} סניפים`,
      body: `${issueLine(totals)} · לחצו לטיפול`,
      url: '/attendance?issues=1',
    });
    officePushes += 1;
  }

  console.log(`[punch-digest] ${day}: ${perBranch.size} branches, ${managerPushes} manager pushes, ${officePushes} office pushes`);
  return { ran: true, branches: perBranch.size, managerPushes, officePushes };
}

module.exports = { tick, MARKER_KEY };
