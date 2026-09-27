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
const { Punch, EmployeeCommitment, PunchResolution, PunchDayExplanation } = require('../models');
const payroll = require('./payroll.controller');
const { loadFollowup } = require('../services/punchFollowup/load');
const fix = require('../services/punchFollowup/fix');
const notificationService = require('../services/notification.service');

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

module.exports = { mine, fixIssue };
