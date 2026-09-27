/**
 * Punch follow-up — the employee's side (stage 2 of
 * docs/superpowers/specs/2026-09-27-punch-followup-design.md).
 *
 *   GET  /api/punch-followup/mine   what she has to fix, and what she already sent
 *   POST /api/punch-followup/fix    her answer to ONE of her own open issues
 *
 * Every write re-reads her issues first and accepts only an issue that is hers
 * and still open — the key in the request is a pointer, never an authority.
 * Punches are written only through payroll.createPunchRequest, so the
 * clock-word-stands and duplicate guards stay the single gatekeepers.
 */
const {
  Punch, EmployeeCommitment, PunchResolution, PunchDayExplanation, PunchFollowupLog, EmployeeRequest, Branch,
} = require('../models');
const payroll = require('./payroll.controller');
const payrollMonth = require('./payrollMonth.controller');
const { loadFollowup } = require('../services/punchFollowup/load');
const fix = require('../services/punchFollowup/fix');
const notificationService = require('../services/notification.service');
const { resolveBranchScope } = require('../utils/branch-scope');
const { invoke } = require('../services/punchFollowup/invoke');

const todayIL = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
const ISR_DAY = (ts) => new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
const ISR_HHMM = (ts) => new Date(ts).toLocaleTimeString('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' });
const HHMM = /^\d{2}:\d{2}$/;
const COUNTED = new Set(['auto', 'approved']);

/** Her issues that she should see (to fix, or as "sent"). */
async function myIssues(emp) {
  const { issues } = await loadFollowup({ today: todayIL(), employeeFilter: { _id: emp._id } });
  return issues.filter(i => i.visibility.employee);
}

/** The facts a card needs: the day's punches and her committed hours. */
async function describe(emp, issues) {
  if (!issues.length) return [];
  const dates = [...new Set(issues.map(i => i.date))].sort();
  const from = new Date(`${dates[0]}T00:00:00Z`); from.setUTCDate(from.getUTCDate() - 1);
  const to = new Date(`${dates[dates.length - 1]}T00:00:00Z`); to.setUTCDate(to.getUTCDate() + 2);
  const [punches, commitment] = await Promise.all([
    Punch.find({
      employee_id: emp._id, timestamp: { $gte: from, $lt: to },
      ignored: { $ne: true }, approval_status: { $ne: 'rejected' },
    }).select('timestamp state approval_status branch_id').sort({ timestamp: 1 }).lean(),
    EmployeeCommitment.findOne({ employee_id: emp._id }).select('days').lean(),
  ]);
  return issues.map((i) => {
    const wd = new Date(`${i.date}T12:00:00Z`).getUTCDay();
    const c = (commitment?.days || []).find(d => d.day === wd);
    return {
      key: i.key, kind: i.kind, date: i.date, state: i.state, view: i.visibility.employee,
      punches: punches.filter(p => ISR_DAY(p.timestamp) === i.date).map(p => ({
        id: String(p._id), hhmm: ISR_HHMM(p.timestamp), state: p.state,
        counted: COUNTED.has(p.approval_status || 'auto'), status: p.approval_status || 'auto',
        branch_id: p.branch_id ? String(p.branch_id) : null,
      })),
      schedule: c && !c.is_off && c.start_hhmm ? { start: c.start_hhmm, end: c.end_hhmm } : null,
    };
  });
}

/** Her branch manager(s) are asked to look — resolved by stage 3's decide. */
function notifyManagers(emp, refCollection, refId, what) {
  notificationService.branchManagerIds(emp.branch_id).then(ids => Promise.all(ids.map(recipient_id =>
    notificationService.createEvent({
      type: 'punch_pending_manager', ref_collection: refCollection, ref_id: refId, recipient_id,
      title: 'ממתין לאישורך', body: `${emp.full_name} — ${what}`, url: '/?punch_followup=1',
    })))).catch(err => console.error('[punch-followup] manager push failed:', err.message));
}

/** GET /api/punch-followup/mine */
async function mine(req, res, next) {
  try {
    const emp = await payroll.resolveSelfEmployee(req);
    if (!emp) return res.json({ issues: [] });
    res.json({ issues: await describe(emp, await myIssues(emp)) });
  } catch (err) { next(err); }
}

/** POST /api/punch-followup/fix  { issue_key, … } */
async function fixIssue(req, res, next) {
  try {
    const emp = await payroll.resolveSelfEmployee(req);
    if (!emp) return res.status(404).json({ error: 'אין רשומת עובד מקושרת למשתמש' });
    const key = String(req.body?.issue_key || '');
    const issue = (await myIssues(emp)).find(i => i.key === key);
    if (!issue) return res.status(404).json({ error: 'הבעיה לא נמצאה או שכבר טופלה' });
    if (issue.state !== 'open') return res.status(409).json({ error: 'כבר נשלח תיקון — ממתין לאישור המנהלת' });
    const [card] = await describe(emp, [issue]);
    const counted = card.punches.filter(p => p.counted);
    const note = String(req.body?.note || '').trim().slice(0, 300);
    const body = req.body || {};

    if (issue.kind === 'missing') {
      const time = String(body.time || '');
      if (!HHMM.test(time)) return res.status(400).json({ error: 'יש למלא את השעה החסרה' });
      const side = fix.missingSide(counted[0], time);
      req.body = { date: issue.date, [side === 'in' ? 'in_time' : 'out_time']: time, note, branch_id: counted[0].branch_id || '' };
      return payroll.createPunchRequest(req, res, next);
    }

    if (issue.kind === 'empty_day') {
      if (body.action === 'worked') {
        const inT = String(body.in_time || '');
        const outT = String(body.out_time || '');
        if (!HHMM.test(inT) || !HHMM.test(outT)) return res.status(400).json({ error: 'יש למלא שעת כניסה ושעת יציאה' });
        if (outT <= inT) return res.status(400).json({ error: 'שעת היציאה חייבת להיות אחרי שעת הכניסה' });
        req.body = { date: issue.date, in_time: inT, out_time: outT, note, branch_id: '' };
        return payroll.createPunchRequest(req, res, next);
      }
      if (body.action === 'other') {
        const text = String(body.text || '').trim().slice(0, 300);
        if (!text) return res.status(400).json({ error: 'יש לכתוב הסבר קצר' });
        const doc = await PunchDayExplanation.findOneAndUpdate(
          { employee_id: emp._id, date: issue.date },
          { $set: { reason_text: text, status: 'pending_manager', decided_by: null, decided_at: null, reject_reason: '' } },
          { upsert: true, new: true },
        );
        notifyManagers(emp, 'PunchDayExplanation', doc._id, 'הסבר ליום ללא החתמות');
        return res.json({ ok: true });
      }
      return res.status(400).json({ error: 'פעולה לא מוכרת' });
    }

    if (issue.kind === 'duplicate') {
      const labels = Array.isArray(body.labels) ? body.labels : [];
      const err = fix.validateLabels(labels, counted.map(p => p.id));
      if (err) return res.status(400).json({ error: err });
      const existing = await PunchResolution.findOne({ employee_id: emp._id, date: issue.date }).select('status').lean();
      if (existing && existing.status !== 'pending_manager') {
        return res.status(409).json({ error: 'היום הזה כבר בטיפול המנהלת או הנהלת החשבונות' });
      }
      const doc = await PunchResolution.findOneAndUpdate(
        { employee_id: emp._id, date: issue.date },
        {
          $set: {
            branch_id: counted[0]?.branch_id || emp.branch_id,
            status: 'pending_manager', proposed_by_role: 'employee',
            proposed_by: req.user?.id || null, proposed_by_name: emp.full_name || '', proposed_at: new Date(),
            labels: labels.map(l => ({ punch_id: l.punch_id, role: l.role })), note,
          },
        },
        { upsert: true, new: true },
      );
      notifyManagers(emp, 'PunchResolution', doc._id, 'סימון החתמות כפולות');
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'סוג בעיה לא מוכר' });
  } catch (err) { next(err); }
}


/* ------------------------------------------------------------------ *
 *  The manager's side (stage 3)
 * ------------------------------------------------------------------ */

const AT_MANAGER = new Set(['pending', 'pending_manager']);

/** A UTC Date some whole days from a 'YYYY-MM-DD' midnight — a query margin; the exact Israel day is filtered after. */
const dayBound = (ymd, days) => new Date(new Date(`${ymd}T00:00:00Z`).getTime() + days * 864e5);

/** Israeli mobile → the international form wa.me needs; '' when unusable. */
function waNumber(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('972') && d.length === 12) return d;
  if (d.startsWith('0') && d.length === 10) return `972${d.slice(1)}`;
  return '';
}

/** Her in-scope issues that the manager should see, plus the employees. */
async function managerIssues(req) {
  const scope = await resolveBranchScope(req);
  const employeeFilter = scope === null ? {} : { branch_id: { $in: scope } };
  const { window, issues, employeesById } = await loadFollowup({ today: todayIL(), employeeFilter });
  return { active: !!window, issues: issues.filter(i => i.visibility.manager), employeesById };
}

/** Everything a manager card shows, for many employees at once. */
async function describeForManager(issues, employeesById) {
  if (!issues.length) return [];
  const empIds = [...new Set(issues.map(i => i.employee_id))];
  const dates = [...new Set(issues.map(i => i.date))].sort();
  const from = new Date(`${dates[0]}T00:00:00Z`); from.setUTCDate(from.getUTCDate() - 1);
  const to = new Date(`${dates[dates.length - 1]}T00:00:00Z`); to.setUTCDate(to.getUTCDate() + 2);
  const keys = issues.map(i => i.key);
  const userIds = empIds.map(id => employeesById.get(id)?.user_id).filter(Boolean);
  const [punches, commitments, resolutions, explanations, requests, logs, branches] = await Promise.all([
    Punch.find({ employee_id: { $in: empIds }, timestamp: { $gte: from, $lt: to }, ignored: { $ne: true }, approval_status: { $ne: 'rejected' } })
      .select('employee_id timestamp state approval_status branch_id manual_note').sort({ timestamp: 1 }).lean(),
    EmployeeCommitment.find({ employee_id: { $in: empIds } }).select('employee_id days').lean(),
    PunchResolution.find({ employee_id: { $in: empIds }, date: { $in: dates } }).select('employee_id date status labels note').lean(),
    PunchDayExplanation.find({ employee_id: { $in: empIds }, date: { $in: dates } }).select('employee_id date status reason_text').lean(),
    EmployeeRequest.find({
      $or: [{ employee_id: { $in: empIds } }, ...(userIds.length ? [{ user_id: { $in: userIds } }] : [])],
      type: { $in: ['sick', 'vacation', 'pregnancy_exam'] }, status: { $in: ['pending', 'pending_manager'] },
      from_date: { $lte: dates[dates.length - 1] },
    }).select('employee_id user_id type from_date to_date status').lean(),
    PunchFollowupLog.find({ issue_key: { $in: keys }, action: { $in: ['manager_whatsapp', 'manager_push'] } })
      .select('issue_key action at').sort({ at: -1 }).lean(),
    Branch.find({ _id: { $in: [...new Set(issues.map(i => i.branch_id).filter(Boolean))] } }).select('name').lean(),
  ]);
  const branchName = new Map(branches.map(b => [String(b._id), b.name]));
  const commitByEmp = new Map(commitments.map(c => [String(c.employee_id), c]));
  const empByUser = new Map([...employeesById.values()].filter(e => e.user_id).map(e => [String(e.user_id), String(e._id)]));
  const today = todayIL();
  return issues.map((i) => {
    const e = employeesById.get(i.employee_id) || {};
    const dayP = punches.filter(p => String(p.employee_id) === i.employee_id && ISR_DAY(p.timestamp) === i.date);
    const wd = new Date(`${i.date}T12:00:00Z`).getUTCDay();
    const c = (commitByEmp.get(i.employee_id)?.days || []).find(d => d.day === wd);
    const res = resolutions.find(r => String(r.employee_id) === i.employee_id && r.date === i.date);
    const expl = explanations.find(x => String(x.employee_id) === i.employee_id && x.date === i.date);
    const reqs = requests.filter(r => (r.employee_id ? String(r.employee_id) : empByUser.get(String(r.user_id))) === i.employee_id
      && r.from_date <= i.date && i.date <= (r.to_date || r.from_date));
    const last = logs.find(l => l.issue_key === i.key);
    const hhmmOf = new Map(dayP.map(p => [String(p._id), ISR_HHMM(p.timestamp)]));
    return {
      key: i.key, kind: i.kind, date: i.date, state: i.state, view: i.visibility.manager,
      employee_id: i.employee_id, full_name: e.full_name || '', first_name: e.first_name || '', has_user: i.has_user, has_phone: !!waNumber(e.phone),
      branch_name: branchName.get(i.branch_id) || '',
      days_open: Math.max(0, Math.round((new Date(`${today}T12:00:00Z`) - new Date(`${i.date}T12:00:00Z`)) / 864e5)),
      punches: dayP.map(p => ({
        id: String(p._id), hhmm: ISR_HHMM(p.timestamp), state: p.state,
        counted: COUNTED.has(p.approval_status || 'auto'), status: p.approval_status || 'auto',
        branch_id: p.branch_id ? String(p.branch_id) : null, note: p.manual_note || '',
      })),
      schedule: c && !c.is_off && c.start_hhmm ? { start: c.start_hhmm, end: c.end_hhmm } : null,
      reported: {
        punches: dayP.filter(p => AT_MANAGER.has(p.approval_status)).map(p => ({ hhmm: ISR_HHMM(p.timestamp), note: p.manual_note || '' })),
        labels: res && res.status === 'pending_manager'
          ? res.labels.map(l => ({ hhmm: hhmmOf.get(String(l.punch_id)) || '?', role: l.role })) : null,
        explanation: expl && expl.status === 'pending_manager' ? expl.reason_text : null,
        request: reqs[0] ? { type: reqs[0].type, status: reqs[0].status } : null,
      },
      last_reminder: last ? { action: last.action, at: last.at } : null,
    };
  });
}

/** GET /api/punch-followup/manager */
async function managerList(req, res, next) {
  try {
    const { active, issues, employeesById } = await managerIssues(req);
    const cards = await describeForManager(issues, employeesById);
    res.json({
      active,
      awaiting: cards.filter(c => c.view === 'awaiting'),
      unhandled: cards.filter(c => c.view === 'unhandled'),
    });
  } catch (err) { next(err); }
}

/** One of HER in-scope issues by key, with its employee — or an error reply. */
async function scopedIssue(req, res, allowed) {
  const key = String(req.body?.issue_key || '');
  const { issues, employeesById } = await managerIssues(req);
  const issue = issues.find(i => i.key === key);
  if (!issue) { res.status(404).json({ error: 'הבעיה לא נמצאה או שכבר טופלה' }); return null; }
  if (!allowed.includes(issue.visibility.manager)) { res.status(409).json({ error: 'הבעיה אינה במצב שמאפשר את הפעולה הזו' }); return null; }
  return { issue, emp: employeesById.get(issue.employee_id) };
}

/** The employee hears what happened to what she sent — once. */
function tellEmployee(emp, refCollection, refId, approved, date, reason) {
  if (!emp?.user_id) return;
  notificationService.notifyOnce({
    type: 'punch_followup_decision', ref_collection: refCollection, ref_id: refId, recipient_id: emp.user_id,
    title: approved ? 'התיקון שלך אושר' : 'התיקון שלך נדחה',
    body: approved ? `התיקון ל${fix.dayLabel(date)} אושר ע״י המנהלת` : `התיקון ל${fix.dayLabel(date)} נדחה${reason ? `: ${reason}` : ''} — יש לתקן שוב`,
    url: approved ? '/my-attendance' : '/?punch_fix=1',
  }).catch(err => console.error('[punch-followup] decision push failed:', err.message));
}

/** POST /api/punch-followup/decide  { issue_key, approve, reason } */
async function decide(req, res, next) {
  try {
    const found = await scopedIssue(req, res, ['awaiting']);
    if (!found) return undefined;
    const { issue, emp } = found;
    const approve = req.body?.approve !== false;
    const reason = String(req.body?.reason || '').trim().slice(0, 300);
    if (!approve && !reason) return res.status(400).json({ error: 'יש לכתוב סיבה לדחייה — העובדת תראה אותה' });

    // 1) Reported punches (a missing side, or a whole "worked" day).
    const reported = await Punch.find({
      employee_id: issue.employee_id,
      timestamp: { $gte: dayBound(issue.date, -1), $lt: dayBound(issue.date, 2) },
      approval_status: { $in: [...AT_MANAGER] }, ignored: { $ne: true },
    }).select('_id timestamp').lean();
    const dayReported = reported.filter(p => ISR_DAY(p.timestamp) === issue.date);
    if (dayReported.length) {
      for (const p of dayReported) {
        const r = await invoke(approve ? payroll.approvePunch : payroll.rejectPunch, req, {
          params: { id: String(p._id) }, body: approve ? {} : { note: reason },
        });
        if (r.status >= 400) return res.status(r.status).json(r.body);
      }
      return res.json({ ok: true });
    }

    // 2) The employee's duplicate labels.
    const resDoc = await PunchResolution.findOne({ employee_id: issue.employee_id, date: issue.date, status: 'pending_manager' }).lean();
    if (resDoc) {
      if (approve) {
        const r = await invoke(payrollMonth.resolvePunchDay, req, {
          body: { employee_id: String(issue.employee_id), date: issue.date, labels: resDoc.labels.map(l => ({ punch_id: String(l.punch_id), role: l.role })), note: resDoc.note || '' },
        });
        if (r.status >= 400) return res.status(r.status).json(r.body);
      } else {
        await PunchResolution.deleteOne({ _id: resDoc._id, status: 'pending_manager' });
      }
      await notificationService.resolveEvents({ ref_collection: 'PunchResolution', ref_id: resDoc._id });
      tellEmployee(emp, 'PunchResolution', resDoc._id, approve, issue.date, reason);
      return res.json({ ok: true });
    }

    // 3) Her explanation for a day she did not work.
    const expl = await PunchDayExplanation.findOne({ employee_id: issue.employee_id, date: issue.date, status: 'pending_manager' });
    if (expl) {
      expl.status = approve ? 'accepted' : 'rejected';
      expl.decided_by = req.user?.id || null;
      expl.decided_at = new Date();
      expl.reject_reason = approve ? '' : reason;
      await expl.save();
      await notificationService.resolveEvents({ ref_collection: 'PunchDayExplanation', ref_id: expl._id });
      tellEmployee(emp, 'PunchDayExplanation', expl._id, approve, issue.date, reason);
      return res.json({ ok: true });
    }

    // 4) A sick/vacation request — decided where requests are decided.
    return res.status(409).json({ error: 'זו בקשת מחלה/חופשה — ההחלטה עליה במסך "בקשות"', go: '/employee-requests' });
  } catch (err) { next(err); }
}

/** POST /api/punch-followup/fix-as-manager  { issue_key, … } — she fixes it herself. */
async function fixAsManager(req, res, next) {
  try {
    const found = await scopedIssue(req, res, ['unhandled', 'awaiting']);
    if (!found) return undefined;
    const { issue } = found;
    const body = req.body || {};
    const note = String(body.note || '').trim().slice(0, 300);
    const empId = String(issue.employee_id);

    if (issue.kind === 'missing') {
      const time = String(body.time || '');
      if (!HHMM.test(time)) return res.status(400).json({ error: 'יש למלא את השעה החסרה' });
      const dayP = (await Punch.find({
        employee_id: issue.employee_id,
        timestamp: { $gte: dayBound(issue.date, -1), $lt: dayBound(issue.date, 2) },
        approval_status: { $in: ['auto', 'approved'] }, ignored: { $ne: true },
      }).select('timestamp state branch_id').lean()).filter(p => ISR_DAY(p.timestamp) === issue.date);
      const one = dayP[0];
      if (!one) return res.status(409).json({ error: 'היום השתנה בינתיים — רענני' });
      const side = fix.missingSide({ state: one.state, hhmm: ISR_HHMM(one.timestamp) }, time);
      const r = await invoke(payroll.createManualPunches, req, {
        body: { employee_id: empId, date: issue.date, [side === 'in' ? 'in_time' : 'out_time']: time, note, branch_id: one.branch_id ? String(one.branch_id) : '' },
      });
      return res.status(r.status).json(r.body);
    }
    if (issue.kind === 'empty_day') {
      if (body.action === 'worked') {
        const inT = String(body.in_time || '');
        const outT = String(body.out_time || '');
        if (!HHMM.test(inT) || !HHMM.test(outT) || outT <= inT) return res.status(400).json({ error: 'יש למלא שעת כניסה ושעת יציאה תקינות' });
        const r = await invoke(payroll.createManualPunches, req, { body: { employee_id: empId, date: issue.date, in_time: inT, out_time: outT, note } });
        return res.status(r.status).json(r.body);
      }
      if (body.action === 'other') {
        const text = String(body.text || '').trim().slice(0, 300);
        if (!text) return res.status(400).json({ error: 'יש לכתוב הסבר קצר' });
        const doc = await PunchDayExplanation.findOneAndUpdate(
          { employee_id: issue.employee_id, date: issue.date },
          { $set: { reason_text: text, status: 'accepted', decided_by: req.user?.id || null, decided_at: new Date(), reject_reason: '' } },
          { upsert: true, new: true },
        );
        // Her own pending explanation (if any) is superseded — close its push.
        await notificationService.resolveEvents({ ref_collection: 'PunchDayExplanation', ref_id: doc._id });
        return res.json({ ok: true });
      }
      return res.status(400).json({ error: 'פעולה לא מוכרת' });
    }
    if (issue.kind === 'duplicate') {
      const labels = Array.isArray(body.labels) ? body.labels : [];
      const r = await invoke(payrollMonth.resolvePunchDay, req, { body: { employee_id: empId, date: issue.date, labels, note } });
      // resolvePunchDay upserts the same (employee, date) row, so the
      // employee's waiting labels are superseded — close their push too.
      if (r.status < 400 && r.body?.resolution?._id) {
        await notificationService.resolveEvents({ ref_collection: 'PunchResolution', ref_id: r.body.resolution._id });
      }
      return res.status(r.status).json(r.body);
    }
    return res.status(400).json({ error: 'סוג בעיה לא מוכר' });
  } catch (err) { next(err); }
}

/** POST /api/punch-followup/remind  { issue_key, channel: 'whatsapp'|'push' } */
async function remind(req, res, next) {
  try {
    const found = await scopedIssue(req, res, ['unhandled', 'awaiting']);
    if (!found) return undefined;
    const { issue, emp } = found;
    const channel = req.body?.channel;
    const text = fix.reminderText(issue.kind, issue.date, fix.greetingName(emp, req.body?.greeting));
    const log = (action) => PunchFollowupLog.create({
      issue_key: issue.key, employee_id: issue.employee_id, date: issue.date, kind: issue.kind, action, by_user: req.user?.id || null,
    });

    if (channel === 'whatsapp') {
      const num = waNumber(emp?.phone);
      if (!num) return res.status(400).json({ error: 'אין לעובדת מספר נייד תקין בכרטיס' });
      await log('manager_whatsapp');
      return res.json({ url: `https://wa.me/${num}?text=${encodeURIComponent(text)}` });
    }
    if (channel === 'push') {
      if (!emp?.user_id) return res.status(400).json({ error: 'לעובדת אין אפליקציה — שלחי תזכורת בוואטסאפ' });
      const dayStart = new Date(`${todayIL()}T00:00:00+03:00`);
      const already = await PunchFollowupLog.exists({ issue_key: issue.key, action: 'manager_push', at: { $gte: dayStart } });
      if (already) return res.status(409).json({ error: 'כבר נשלחה היום תזכורת בפוש על היום הזה' });
      await notificationService.notifyOnce({
        type: 'punch_followup_reminder', ref_collection: 'Employee', ref_id: emp._id, recipient_id: emp.user_id,
        title: 'תזכורת מהמנהלת', body: text, url: '/?punch_fix=1',
      });
      await log('manager_push');
      return res.json({ ok: true });
    }
    return res.status(400).json({ error: 'ערוץ לא מוכר' });
  } catch (err) { next(err); }
}

module.exports = { mine, fixIssue, managerList, decide, fixAsManager, remind, _internals: { describeForManager } };
