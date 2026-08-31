const express = require('express');
const crypto = require('crypto');

const PunchEntryTask = require('../models/PunchEntryTask');
const EmployeeRequest = require('../models/EmployeeRequest');
const EmployeeChangeRequest = require('../models/EmployeeChangeRequest');
// Required for their own sake, not for a reference in this file: populate()
// resolves a ref by MODEL NAME at query time, and if nothing has registered
// Branch or Employee yet, mongoose throws MissingSchemaError from inside the
// query. Importing them here makes that impossible to get wrong.
require('../models/Branch');
require('../models/Employee');

const router = express.Router();

// ── The contract with the task board ────────────────────────────────────────
//
// tofy-tasks shows the open work of both businesses on one screen. From here it
// takes only what is genuinely WAITING FOR SOMEBODY: punch-entry assignments and
// the approval queues.
//
// READ-ONLY, and that is a decision rather than an omission. These items close
// as a RESULT of real work — a manager actually entering the missing punches, an
// accountant actually approving a request. Letting the board tick one off would
// record that the job was done while the data was still missing, which is the
// same gap that once left an employee reporting eighteen punches by hand.
//
// Every route here is a GET with no body, so the signature covers the empty
// string and no raw-body capture is needed in index.js.
const VERSION = 1;

function verifyCaller(req, res) {
  const secret = process.env.TASKS_SYNC_KEY || '';
  if (!secret || secret.length < 32) {
    res.status(503).json({ error: { code: 'NOT_CONFIGURED', message: 'סנכרון המשימות לא הוגדר בשרת' } });
    return false;
  }
  const key = String(req.headers['x-sync-key'] || '');
  const keyBuf = Buffer.from(key);
  const secretBuf = Buffer.from(secret);
  if (keyBuf.length !== secretBuf.length || !crypto.timingSafeEqual(keyBuf, secretBuf)) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'מפתח לא תקין' } });
    return false;
  }
  const ts = Number(req.headers['x-sync-ts'] || 0);
  const sig = String(req.headers['x-sync-sig'] || '');
  if (!ts || Math.abs(Date.now() / 1000 - ts) > 300) {
    res.status(401).json({ error: { code: 'STALE', message: 'חותמת זמן לא תקינה' } });
    return false;
  }
  const expected = crypto.createHmac('sha256', secret).update(`${ts}.`).digest('hex');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    res.status(401).json({ error: { code: 'BAD_SIGNATURE', message: 'חתימה לא תקינה' } });
    return false;
  }
  return true;
}

/**
 * Express 4 does not catch a rejection thrown inside an async handler: the
 * request gets NO RESPONSE at all and the caller waits for its own timeout.
 *
 * That is exactly what went wrong here. /v1/tasks hung for two minutes while
 * /ping and /tasks/ids answered in under a second — which reads like a slow
 * database and was in fact a thrown error with nowhere to go. A failure has to
 * be a fast 500 that names itself.
 */
function guard(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(err => {
      console.error('[sync]', (err && err.message) || err);
      if (!res.headersSent) {
        res.status(500).json({
          error: { code: 'SYNC_FAILED', message: String((err && err.message) || err).slice(0, 200) },
        });
      }
    });
  };
}

router.get('/v1/ping', (req, res) => {
  if (!verifyCaller(req, res)) return;
  res.json({ v: VERSION, ok: true, now: new Date().toISOString() });
});

/**
 * Everything here that is waiting for a person, as one stream.
 *
 * `since` is a watermark on updated_at, which Mongoose already maintains — no
 * schema change and no triggers, unlike the SQLite side of this integration.
 *
 * Titles are BUILT here rather than sent as raw fields. The board shows one
 * line per item, and "בקשת חופשה — נועה כהן" is a line somebody can act on
 * where a type code and three ids are not.
 */
router.get('/v1/tasks', guard(async (req, res) => {
  if (!verifyCaller(req, res)) return;

  const since = new Date(req.query.since || 0);
  const limit = Math.min(Number(req.query.limit) || 500, 2000);
  const out = [];

  const punches = await PunchEntryTask.find({ updated_at: { $gt: since } })
    .populate('branch_id', 'name')
    .sort({ updated_at: 1 })
    .limit(limit)
    .lean();
  for (const p of punches) {
    const branch = p.branch_id && p.branch_id.name ? p.branch_id.name : 'סניף';
    out.push({
      id: String(p._id),
      kind: 'punch_entry',
      title: `הזנת החתמות חסרות — ${branch} · ${p.month}`,
      description: p.missing_count_at_assign
        ? `${p.missing_count_at_assign} החתמות חסרות בעת ההקצאה`
        : '',
      // 'cancelled' is closed as far as a board is concerned: nothing is waiting.
      done: p.status !== 'open',
      done_at: p.completed_at || null,
      branch,
      updated_at: p.updated_at,
    });
  }

  const requests = await EmployeeRequest.find({ updated_at: { $gt: since } })
    .populate('employee_id', 'full_name first_name last_name')
    .populate('branch_id', 'name')
    .sort({ updated_at: 1 })
    .limit(limit)
    .lean();
  for (const r of requests) {
    out.push({
      id: String(r._id),
      kind: 'employee_request',
      title: `${REQUEST_TYPE[r.type] || 'בקשת עובד'} — ${personName(r.employee_id)}`,
      description: [r.from_date && `מתאריך ${r.from_date}`, r.to_date && `עד ${r.to_date}`, r.reason]
        .filter(Boolean)
        .join(' · '),
      // Anything still pending is work. approved/rejected are both finished.
      done: !String(r.status || '').startsWith('pending'),
      done_at: r.reviewed_at || r.manager_reviewed_at || null,
      branch: r.branch_id && r.branch_id.name ? r.branch_id.name : '',
      updated_at: r.updated_at,
    });
  }

  const changes = await EmployeeChangeRequest.find({ updated_at: { $gt: since } })
    .populate('employee_id', 'full_name first_name last_name')
    .sort({ updated_at: 1 })
    .limit(limit)
    .lean();
  for (const c of changes) {
    out.push({
      id: String(c._id),
      kind: 'employee_change',
      title: `בקשת שינוי פרטים — ${personName(c.employee_id)}`,
      description: '',
      done: c.status !== 'pending',
      done_at: c.reviewed_at || null,
      branch: '',
      updated_at: c.updated_at,
    });
  }

  out.sort((a, b) => new Date(a.updated_at) - new Date(b.updated_at));
  const page = out.slice(0, limit);

  res.json({
    v: VERSION,
    now: new Date().toISOString(),
    // Returned explicitly so an empty page cannot rewind the watermark and make
    // the caller re-download everything it already holds.
    cursor: page.length ? new Date(page[page.length - 1].updated_at).toISOString() : new Date(since).toISOString(),
    has_more: out.length > limit,
    tasks: page,
  });
}));

/** Ids only, so the caller can tell a deleted item from one it has not seen.
 *  Cheap: three id projections and nothing else. */
router.get('/v1/tasks/ids', guard(async (req, res) => {
  if (!verifyCaller(req, res)) return;
  const [punch, request, change] = await Promise.all([
    PunchEntryTask.find({}, { _id: 1 }).lean(),
    EmployeeRequest.find({}, { _id: 1 }).lean(),
    EmployeeChangeRequest.find({}, { _id: 1 }).lean(),
  ]);
  res.json({
    v: VERSION,
    now: new Date().toISOString(),
    punch_entry: punch.map(d => String(d._id)),
    employee_request: request.map(d => String(d._id)),
    employee_change: change.map(d => String(d._id)),
  });
}));

// The board is in Hebrew and one line wide. A raw enum value is exactly the
// sort of thing that makes a mirrored item unreadable at a glance.
const REQUEST_TYPE = {
  vacation: 'בקשת חופשה',
  sick: 'דיווח מחלה',
  pregnancy_exam: 'היעדרות לבדיקות הריון',
};

function personName(emp) {
  if (!emp) return 'עובד';
  if (emp.full_name) return emp.full_name;
  return [emp.first_name, emp.last_name].filter(Boolean).join(' ') || 'עובד';
}

module.exports = router;
