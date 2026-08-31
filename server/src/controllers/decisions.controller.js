/**
 * "What was decided on the things I asked for."
 *
 * A branch manager cannot write payroll, employee cards or pay rates directly.
 * Every one of those edits is a REQUEST, reviewed by accounting — three
 * separate collections, each with its own screen, each of which she had to
 * remember to open and then pick the right tab. Nothing ever told her a
 * decision had been made, so in practice she found out from the payslip, which
 * is both too late and the wrong place to learn it.
 *
 * This is the one answer to the one question. It reads all three, for this
 * person only, and marks as new anything decided since she last looked.
 */
const {
  PayrollChangeRequest, EmployeeChangeRequest, RateChangeRequest, Employee, User,
} = require('../models');

/** How far back the list reaches. Older than this is history, not news. */
const WINDOW_DAYS = 90;

const HE_STATUS = {
  approved: 'אושרה',
  rejected: 'נדחתה',
  partially_approved: 'אושרה חלקית',
};

/** '₪1,200' / '3' / '—' — a value as the manager wrote or would read it. */
function showValue(v) {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'כן' : 'לא';
  return String(v);
}

/**
 * The decisions on one person's requests, newest first.
 *
 * `unseen` is computed per row rather than filtered on, so the screen can show
 * the whole recent history with the new ones marked. A list that empties itself
 * the moment it is opened cannot be checked twice, and "what did they say about
 * that one again?" is the second question everybody asks.
 */
async function myDecisions(req, res, next) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const since = new Date(Date.now() - WINDOW_DAYS * 864e5);
    const me = await User.findById(userId).select('decisions_seen_at').lean();
    const seenAt = me?.decisions_seen_at ? new Date(me.decisions_seen_at) : null;

    const [payroll, employee, rates] = await Promise.all([
      PayrollChangeRequest.find({
        requested_by: userId,
        status: { $in: ['approved', 'rejected', 'partially_approved'] },
        decided_at: { $gte: since },
      }).sort({ decided_at: -1 }).limit(100).lean(),

      EmployeeChangeRequest.find({
        requested_by: userId,
        status: { $in: ['approved', 'rejected'] },
        reviewed_at: { $gte: since },
      }).sort({ reviewed_at: -1 }).limit(100).lean(),

      RateChangeRequest.find({
        requested_by: userId,
        status: { $in: ['approved', 'rejected'] },
        decided_at: { $gte: since },
      }).sort({ decided_at: -1 }).limit(100).lean(),
    ]);

    const items = [];

    for (const r of payroll) {
      // A partial approval is the one that MUST be itemised: "אושרה חלקית" on
      // its own tells her something was refused and not which, so she has to
      // go and compare the table against what she asked for, line by line.
      const lines = (r.changes || []).map((c, i) => ({
        label: c.field_label || c.field,
        who: c.employee_name || '',
        from: showValue(c.current_value),
        to: showValue(c.requested_value),
        decision: (r.change_decisions || [])[i]
          || (r.status === 'partially_approved' ? 'pending' : r.status),
      }));
      items.push({
        id: String(r._id),
        kind: 'payroll',
        kind_label: 'שינוי בטבלת השכר',
        title: `חודש ${r.month}${r.branch_name ? ` · ${r.branch_name}` : ''}`,
        status: r.status,
        status_label: HE_STATUS[r.status] || r.status,
        decided_at: r.decided_at,
        decided_by_name: r.decided_by_name || '',
        note: r.decision_note || '',
        lines,
      });
    }

    for (const r of employee) {
      items.push({
        id: String(r._id),
        kind: 'employee',
        kind_label: 'שינוי בכרטיס עובד/ת',
        title: r.employee_name || 'עובד/ת',
        status: r.status,
        status_label: HE_STATUS[r.status] || r.status,
        decided_at: r.reviewed_at,
        decided_by_name: '',
        note: r.review_note || '',
        // This collection names its own fields: label / before / after, where
        // the payroll one says field_label / current_value / requested_value.
        lines: (r.changes || []).map(c => ({
          label: c.label || c.field,
          who: r.employee_name || '',
          from: showValue(c.before),
          to: showValue(c.after),
          decision: r.status,
        })),
      });
    }

    // A rate request carries the employee by reference only, so the name is
    // fetched rather than read off the row. One query for the batch: a name
    // lookup per request is what turns a small screen into a slow one.
    const rateEmpIds = [...new Set(rates.map(r => String(r.employee_id)).filter(Boolean))];
    const empNames = new Map(rateEmpIds.length
      ? (await Employee.find({ _id: { $in: rateEmpIds } }).select('full_name').lean())
        .map(e => [String(e._id), e.full_name])
      : []);

    for (const r of rates) {
      const isGlobal = r.salary_type === 'global';
      const to = isGlobal ? r.global_salary : r.hourly_rate;
      items.push({
        id: String(r._id),
        kind: 'rate',
        kind_label: 'שינוי תעריף',
        title: empNames.get(String(r.employee_id)) || 'עובד/ת',
        status: r.status,
        status_label: HE_STATUS[r.status] || r.status,
        decided_at: r.decided_at,
        decided_by_name: r.decided_by_name || '',
        note: r.decided_note || r.reason || '',
        lines: [{
          // The date is part of the request, not decoration: a rate is what it
          // was ON a date, and an approval that moved the date is a different
          // answer from the one that was asked for.
          label: isGlobal ? 'שכר גלובלי' : 'שכר שעתי',
          who: r.effective_date
            ? `מתאריך ${new Date(r.effective_date).toLocaleDateString('he-IL')}`
            : '',
          from: '',
          to: showValue(to),
          decision: r.status,
        }],
      });
    }

    // A request with no decision time sorts last rather than first: Date(null)
    // is 1970, and a row with a missing timestamp is not the newest news.
    items.sort((a, b) => (
      new Date(b.decided_at || 0).getTime() - new Date(a.decided_at || 0).getTime()
    ));
    for (const it of items) {
      it.unseen = !seenAt || (it.decided_at && new Date(it.decided_at) > seenAt);
    }

    res.json({
      items,
      unseen_count: items.filter(i => i.unseen).length,
      seen_at: seenAt,
    });
  } catch (err) { next(err); }
}

/**
 * POST /api/my-decisions/seen — "I have read these."
 *
 * Stamped from the newest item the caller was actually shown rather than from
 * `now`: a decision landing between the render and the click would otherwise be
 * marked read without ever having been on screen. Falls back to now when the
 * list was empty, which is the only case where there is nothing to miss.
 */
async function markSeen(req, res, next) {
  try {
    const upTo = req.body?.up_to ? new Date(req.body.up_to) : null;
    const at = (upTo && !Number.isNaN(upTo.getTime())) ? upTo : new Date();
    await User.updateOne({ _id: req.user.id }, { $set: { decisions_seen_at: at } });
    res.json({ ok: true, seen_at: at });
  } catch (err) { next(err); }
}

module.exports = { myDecisions, markSeen, showValue };
