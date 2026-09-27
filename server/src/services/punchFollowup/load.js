'use strict';

/**
 * Punch follow-up — the DATABASE side. Reads only; everything it decides, it
 * decides by handing plain objects to engine.js. Never call punchIssues from
 * here: that function rejects mirrored reports as a side effect.
 */
const {
  Employee, Punch, EmployeeCommitment, EmployeeRequest, Holiday, SpecialDay,
  PunchResolution, PunchDayExplanation, Setting,
} = require('../../models');
const { buildIssues, followupWindow, visibility, addDays } = require('./engine');

const START_KEY = 'punch_followup_start_date';
const ISR_DAY = (ts) => new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });

async function loadFollowup({ today, employeeFilter = {}, startOverride = null }) {
  const start = startOverride || (await Setting.findOne({ key: START_KEY }).lean())?.value || null;
  const window = followupWindow(today, start);
  if (!window) return { window: null, issues: [], employeesById: new Map() };

  const employees = await Employee.find({ ...employeeFilter, is_active: { $ne: false } })
    .select('_id full_name first_name branch_id start_date is_active receives_salary user_id phone').lean();
  const ids = employees.map(e => e._id);
  const userIds = employees.map(e => e.user_id).filter(Boolean);
  const empByUser = new Map(employees.filter(e => e.user_id).map(e => [String(e.user_id), String(e._id)]));
  const branchIds = [...new Set(employees.map(e => String(e.branch_id)).filter(Boolean))];

  // A generous UTC margin, then the exact Israel day is taken per punch.
  const fromTs = new Date(`${addDays(window.from, -1)}T00:00:00Z`);
  const toTs = new Date(`${addDays(window.to, 2)}T00:00:00Z`);

  const [punches, commitments, requests, holidays, specials, resolutions, explanations] = await Promise.all([
    Punch.find({ employee_id: { $in: ids }, timestamp: { $gte: fromTs, $lt: toTs }, ignored: { $ne: true } })
      .select('employee_id timestamp approval_status').lean(),
    EmployeeCommitment.find({ employee_id: { $in: ids } })
      .select('employee_id days is_alternating_off alternating_day').lean(),
    EmployeeRequest.find({
      $or: [{ employee_id: { $in: ids } }, ...(userIds.length ? [{ user_id: { $in: userIds } }] : [])],
      type: { $in: ['sick', 'vacation', 'pregnancy_exam'] },
      from_date: { $lte: window.to },
    }).select('employee_id user_id from_date to_date status').lean(),
    Holiday.find({
      branch_id: { $in: branchIds }, kind: { $ne: 'short_day' },
      start_date: { $lte: toTs }, end_date: { $gte: fromTs },
    }).select('branch_id start_date end_date').lean(),
    SpecialDay.find({ date: { $gte: window.from, $lte: window.to } }).select('branch_id date').lean(),
    PunchResolution.find({ employee_id: { $in: ids }, date: { $gte: window.from, $lte: window.to } })
      .select('employee_id date status').lean(),
    PunchDayExplanation.find({ employee_id: { $in: ids }, date: { $gte: window.from, $lte: window.to } })
      .select('employee_id date status').lean(),
  ]);

  const issues = buildIssues({
    window,
    employees: employees.map(e => ({
      id: String(e._id), branch_id: e.branch_id ? String(e.branch_id) : null,
      start_date: e.start_date ? ISR_DAY(e.start_date) : null,
      is_active: e.is_active, receives_salary: e.receives_salary,
    })),
    punches: punches.map(p => ({ employee_id: String(p.employee_id), day: ISR_DAY(p.timestamp), approval_status: p.approval_status || 'auto' })),
    commitments: new Map(commitments.map(c => [String(c.employee_id), c])),
    requests: requests
      .map(r => ({ ...r, employee_id: r.employee_id ? String(r.employee_id) : empByUser.get(String(r.user_id)) }))
      .filter(r => r.employee_id),
    closures: [
      ...holidays.map(h => ({ branch_id: String(h.branch_id), from: ISR_DAY(h.start_date), to: ISR_DAY(h.end_date) })),
      ...specials.map(s => ({ branch_id: s.branch_id ? String(s.branch_id) : null, from: s.date, to: s.date })),
    ],
    resolutions: resolutions.map(r => ({ ...r, employee_id: String(r.employee_id) })),
    explanations: explanations.map(x => ({ ...x, employee_id: String(x.employee_id) })),
  });

  const employeesById = new Map(employees.map(e => [String(e._id), e]));
  for (const i of issues) {
    i.has_user = !!employeesById.get(i.employee_id)?.user_id;
    i.visibility = visibility(i, { today, hasUser: i.has_user });
  }
  return { window, issues, employeesById };
}

module.exports = { loadFollowup, START_KEY };
