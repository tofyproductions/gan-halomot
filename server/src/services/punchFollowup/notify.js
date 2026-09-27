'use strict';

/**
 * Punch follow-up — the employee's 07:00 push (stage 2). Called from the
 * existing punchIssuesDigest tick, once a day. Only issues that became hers
 * YESTERDAY are pushed, each exactly once (PunchFollowupLog); older open
 * issues are left to the popup, which is the repeating reminder.
 */
const { PunchFollowupLog } = require('../../models');
const { loadFollowup } = require('./load');
const { addDays } = require('./engine');
const fix = require('./fix');
const notificationService = require('../notification.service');

async function sendEmployeeMorningPushes({ today }) {
  const { window, issues, employeesById } = await loadFollowup({ today });
  if (!window) return { pushes: 0, dormant: true };
  const keys = issues.map(i => i.key);
  const sent = new Set((await PunchFollowupLog.find({ issue_key: { $in: keys }, action: 'employee_push' })
    .select('issue_key').lean()).map(l => l.issue_key));
  const byEmp = fix.pickEmployeePushes(issues, sent, addDays(today, -1));

  let pushes = 0;
  for (const [empId, list] of byEmp) {
    const emp = employeesById.get(empId);
    if (!emp?.user_id) continue;
    const { title, body } = fix.pushText(list);
    await notificationService.notifyOnce({
      type: 'punch_followup_employee', ref_collection: 'Employee', ref_id: emp._id,
      recipient_id: emp.user_id, title, body, url: '/?punch_fix=1',
    });
    await PunchFollowupLog.insertMany(list.map(i => ({
      issue_key: i.key, employee_id: emp._id, date: i.date, kind: i.kind, action: 'employee_push',
    })));
    pushes += 1;
  }
  return { pushes };
}

/**
 * The manager digest's numbers once the follow-up is live: per branch, how
 * many answers wait for her approval and how many days nobody handled.
 * null while dormant — the digest then keeps its old month-to-date counts.
 */
async function managerDigestCounts({ today }) {
  const { window, issues } = await loadFollowup({ today });
  if (!window) return null;
  const perBranch = new Map();
  for (const i of issues) {
    const v = i.visibility?.manager;
    if (!v || !i.branch_id) continue;
    if (!perBranch.has(i.branch_id)) perBranch.set(i.branch_id, { awaiting: 0, unhandled: 0 });
    perBranch.get(i.branch_id)[v] += 1;
  }
  return perBranch;
}

module.exports = { sendEmployeeMorningPushes, managerDigestCounts };
