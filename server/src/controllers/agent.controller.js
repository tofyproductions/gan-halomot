const { Punch, Employee, AgentCommand } = require('../models');

/**
 * POST /api/agent/:branchId/punches
 *
 * Batch upload from the Pi agent. Body:
 *   {
 *     agent_version: "1.0.0",
 *     punches: [
 *       {
 *         device_user_sn: 1234,        // unique per clock — used for dedup
 *         device_user_id: 5,           // internal uid on clock
 *         israeli_id: "324235241",     // the clock's userId
 *         timestamp: "2026-04-15T...", // ISO, from device OR agent's own clock
 *         timestamp_source: "agent_received_at" | "device",
 *         state: 0,
 *         verify_mode: 1
 *       }, ...
 *     ]
 *   }
 *
 * For each punch we upsert on (branch_id, device_user_sn). If an Employee
 * with a matching israeli_id exists we link it; otherwise the punch is stored
 * unlinked and will resolve later (once the employee is imported).
 */
async function uploadPunches(req, res, next) {
  try {
    const branch = req.branch; // from agentAuth middleware
    const { punches = [], agent_version = '' } = req.body || {};

    if (!Array.isArray(punches)) {
      return res.status(400).json({ error: 'punches must be an array' });
    }

    // Heartbeat-lite: uploading punches also counts as "we saw the agent".
    branch.agent_last_seen_at = new Date();
    if (agent_version) branch.agent_version = agent_version;
    await branch.save();

    // Normalize the incoming punches' Israeli IDs to 9 digits so matching
    // against Employee.israeli_id is consistent (the clock sometimes drops
    // leading zeros, returning e.g. "24073124" for "024073124").
    const normalizeIsraeliId = (v) => {
      const digits = String(v || '').replace(/\D/g, '');
      if (digits.length >= 7 && digits.length <= 9) return digits.padStart(9, '0');
      return digits;
    };
    for (const p of punches) {
      if (p && p.israeli_id != null) p.israeli_id = normalizeIsraeliId(p.israeli_id);
    }

    // Preload employees for any Israeli IDs referenced — one round trip.
    // Cross-branch handling: a punch is matched first against employees of
    // THIS branch (typical case). Any IDs that don't match are then looked
    // up across ALL branches — that catches employees who occasionally show
    // up to help at another branch. The Punch's branch_id stays at the
    // visiting branch (where it physically happened); employee_id points to
    // the worker, so salary aggregation by employee_id works across branches.
    const israeliIds = [...new Set(
      punches.map(p => p && p.israeli_id).filter(Boolean).map(String)
    )];
    const sameBranchEmployees = israeliIds.length
      ? await Employee.find({
          branch_id: branch._id,
          israeli_id: { $in: israeliIds },
          is_active: true,
        }).select('_id israeli_id').lean()
      : [];
    const idMap = new Map(sameBranchEmployees.map(e => [e.israeli_id, e._id]));

    const stillMissing = israeliIds.filter(id => !idMap.has(id));
    if (stillMissing.length) {
      const guests = await Employee.find({
        israeli_id: { $in: stillMissing },
        is_active: true,
      }).select('_id israeli_id branch_id').lean();
      // If multiple branches happen to have the same israeli_id (data quirk),
      // keep the first one and ignore the rest — better than silently dropping.
      for (const e of guests) {
        if (!idMap.has(e.israeli_id)) idMap.set(e.israeli_id, e._id);
      }
    }

    let accepted = 0;
    let duplicates = 0;
    let unmatched = 0;
    const errors = [];
    const ops = [];

    for (const p of punches) {
      if (!p || typeof p.device_user_sn !== 'number' || !p.israeli_id || !p.timestamp) {
        errors.push({ punch: p, reason: 'missing required fields' });
        continue;
      }
      const employeeId = idMap.get(String(p.israeli_id)) || null;
      if (!employeeId) unmatched++;

      // A real ת"ז normalizes to 9 digits; an unmatched id shorter than 7 is a
      // TIMEDOX test/demo user (UID 0-9 used while installing a clock), not a
      // person. Auto-ignore on insert so it never surfaces as "לא מזוהה".
      const isDeviceTestId =
        !employeeId && String(p.israeli_id).replace(/\D/g, '').length < 7;

      ops.push({
        updateOne: {
          filter: { branch_id: branch._id, device_user_sn: p.device_user_sn },
          update: {
            $setOnInsert: {
              branch_id: branch._id,
              device_user_sn: p.device_user_sn,
              device_user_id: p.device_user_id || null,
              israeli_id: String(p.israeli_id),
              employee_id: employeeId,
              timestamp: new Date(p.timestamp),
              timestamp_source: p.timestamp_source || 'agent_received_at',
              state: p.state || 0,
              verify_mode: p.verify_mode || 0,
              received_at: new Date(),
              agent_version,
              ignored: isDeviceTestId,
              ignored_reason: isDeviceTestId
                ? 'ת"ז קצרה מ-7 ספרות — משתמש בדיקה בשעון (0-9), לא עובד'
                : '',
            },
          },
          upsert: true,
        },
      });
    }

    // One bulkWrite instead of N updateOne calls — a full re-pull can be
    // thousands of records, and per-record round-trips blow past the agent's
    // HTTP timeout. Dedup is via the unique (branch_id, device_user_sn) index;
    // existing records simply match and don't insert.
    if (ops.length) {
      try {
        const result = await Punch.bulkWrite(ops, { ordered: false });
        accepted = result.upsertedCount || 0;
      } catch (e) {
        // Duplicate-key races (e.g. overlapping re-pull) are benign — the
        // record already exists. Keep whatever was upserted and move on.
        accepted = e?.result?.upsertedCount || e?.result?.nUpserted || 0;
        const onlyDupes = Array.isArray(e?.writeErrors)
          && e.writeErrors.every(we => we?.err?.code === 11000 || we?.code === 11000);
        if (!onlyDupes && e.code !== 11000) {
          errors.push({ reason: e.message });
        }
      }
      duplicates = ops.length - accepted;
    }

    res.json({
      ok: true,
      accepted,
      duplicates,
      unmatched,
      errors_count: errors.length,
      errors: errors.slice(0, 20), // cap to avoid giant responses
    });
  } catch (err) {
    next(err);
  }
}

// Clock-down alerting thresholds. The agent heartbeats every ~60s; we alert
// only once the clock has been unreachable for a sustained period (so a brief
// reboot doesn't spam), and re-alert at most once per cooldown window.
const CLOCK_DOWN_THRESHOLD_MS = 3 * 60 * 60 * 1000;   // 3h unreachable
const CLOCK_ALERT_COOLDOWN_MS = 12 * 60 * 60 * 1000;  // re-alert every 12h max

/**
 * Email branch managers + system admins when a branch's clock has been
 * unreachable while the agent itself is alive — the exact failure mode that
 * silently hid the May 2026 outage (agent heartbeating, clock not polled).
 * Never throws to the caller; alerting must not break the heartbeat.
 */
async function maybeAlertClockDown(branch, now) {
  if (branch.clock_reachable !== false) return;
  const lastOk = branch.clock_last_ok_at ? branch.clock_last_ok_at.getTime() : 0;
  const downMs = lastOk ? (now.getTime() - lastOk) : Infinity;
  if (downMs < CLOCK_DOWN_THRESHOLD_MS) return;
  const sinceAlert = branch.clock_alerted_at ? (now.getTime() - branch.clock_alerted_at.getTime()) : Infinity;
  if (sinceAlert < CLOCK_ALERT_COOLDOWN_MS) return;

  const { User } = require('../models');
  const recips = await User.find({
    is_active: true,
    $or: [
      { role: 'system_admin' },
      { role: 'branch_manager', $or: [{ managed_branch_ids: branch._id }, { branch_id: branch._id }] },
    ],
  }).select('email').lean();
  const emails = [...new Set(recips.map(r => r.email).filter(Boolean))];
  if (!emails.length) return;

  const hours = Number.isFinite(downMs) ? Math.round(downMs / 3600000) : null;
  const sinceTxt = branch.clock_last_ok_at
    ? new Date(branch.clock_last_ok_at).toLocaleString('he-IL')
    : 'לא ידוע';
  const { dispatchEmail } = require('../services/email.service');
  await dispatchEmail({
    to: emails,
    subject: `⚠️ שעון נוכחות לא מגיב — ${branch.name}`,
    html: `<div dir="rtl" style="font-family:Arial,sans-serif">
      <p>שעון הנוכחות בסניף <b>${branch.name}</b> אינו מגיב${hours != null ? ` כבר כ-${hours} שעות` : ''} (תקין לאחרונה: ${sinceTxt}).</p>
      <p>ייתכן שכתובת ה-IP של השעון השתנתה (DHCP) או שהשעון כבוי/מנותק. <b>החתמות לא נקלטות עד לטיפול.</b></p>
      <p>הסוכן (Pi) עצמו מחובר — הבעיה בחיבור בין ה-Pi לשעון.</p>
    </div>`,
  });
  branch.clock_alerted_at = now;
}

/**
 * POST /api/agent/:branchId/heartbeat
 * Body: { agent_version, clock_reachable, clock_user_count, clock_log_count, last_user_sn }
 */
async function heartbeat(req, res, next) {
  try {
    const branch = req.branch;
    const {
      agent_version = '',
      clock_reachable = null,
      clock_log_count = null,
      last_user_sn = null,
    } = req.body || {};
    const now = new Date();
    // Recovery: a heartbeat means the agent is alive again — clear the
    // "agent silent" alert stamp so a future outage re-alerts immediately.
    if (branch.agent_alerted_at) branch.agent_alerted_at = null;
    branch.agent_last_seen_at = now;
    if (agent_version) branch.agent_version = agent_version;
    if (clock_reachable !== null) branch.clock_reachable = clock_reachable;
    if (clock_log_count != null) branch.clock_log_count = clock_log_count;
    if (last_user_sn != null) branch.clock_last_user_sn = last_user_sn;
    if (clock_reachable === true) branch.clock_last_ok_at = now;

    try { await maybeAlertClockDown(branch, now); } catch (e) { /* never fail heartbeat */ }

    await branch.save();
    res.json({
      ok: true,
      server_time: now.toISOString(),
      branch_id: String(branch._id),
      branch_name: branch.name,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/agent/:branchId/pending-commands
 * Returns up to N commands with status "pending" for this branch and marks
 * them as "sent" (so the agent can retry if needed, but we track delivery).
 */
async function pendingCommands(req, res, next) {
  try {
    const branch = req.branch;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);

    const pending = await AgentCommand.find({
      branch_id: branch._id,
      status: 'pending',
    })
      .sort({ created_at: 1 })
      .limit(limit);

    const ids = pending.map(c => c._id);
    if (ids.length) {
      await AgentCommand.updateMany(
        { _id: { $in: ids } },
        { $set: { status: 'sent', sent_at: new Date() }, $inc: { attempts: 1 } }
      );
    }

    res.json({
      ok: true,
      commands: pending.map(c => ({
        id: String(c._id),
        type: c.type,
        payload: c.payload,
        attempts: c.attempts + 1,
        created_at: c.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/agent/:branchId/command-result
 * Body: { command_id, status: "confirmed"|"failed", result, error }
 */
async function commandResult(req, res, next) {
  try {
    const branch = req.branch;
    const { command_id, status, result = null, error = '' } = req.body || {};

    if (!command_id || !['confirmed', 'failed'].includes(status)) {
      return res.status(400).json({ error: 'command_id and valid status required' });
    }
    const cmd = await AgentCommand.findOne({ _id: command_id, branch_id: branch._id });
    if (!cmd) return res.status(404).json({ error: 'command not found' });

    cmd.status = status;
    cmd.completed_at = new Date();
    cmd.result = result;
    if (status === 'failed') cmd.last_error = String(error || '').slice(0, 500);
    await cmd.save();

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// --- Dead-agent watchdog (server-side, timer-driven) ---------------------
// The heartbeat-driven clock-down alert only runs when a heartbeat arrives, so
// it CANNOT detect an agent that has gone fully silent (the Moshe Dayan June
// 2026 outage: Pi offline 5+ days, zero alerts). This watchdog runs on a server
// timer and emails when a branch hasn't heartbeated for a sustained period.
const AGENT_SILENT_THRESHOLD_MS = 3 * 60 * 60 * 1000;   // 3h with no heartbeat = down
const AGENT_ALERT_COOLDOWN_MS  = 12 * 60 * 60 * 1000;   // re-alert at most every 12h

/**
 * Scan all branches for an agent that has stopped heartbeating and email the
 * branch managers + system admins. Idempotent and rate-limited per branch via
 * agent_alerted_at. Never throws — must not crash the timer.
 * Call periodically (e.g. hourly) from the server bootstrap.
 */
async function checkStaleAgents() {
  try {
    const now = new Date();
    // Only nag during Israel daytime (07:00–21:00) so a night blip doesn't
    // email at 3am. A multi-day outage still alerts on the next daytime tick.
    const ilHour = Number(new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false,
    }).format(now));
    if (ilHour < 7 || ilHour >= 21) return;

    const { Branch, User } = require('../models');
    const { dispatchEmail } = require('../services/email.service');
    // Only branches that have EVER had an agent (ignore branches with no clock).
    const branches = await Branch.find({ agent_last_seen_at: { $ne: null } });
    for (const branch of branches) {
      const lastSeen = branch.agent_last_seen_at ? branch.agent_last_seen_at.getTime() : 0;
      const downMs = now.getTime() - lastSeen;
      if (downMs < AGENT_SILENT_THRESHOLD_MS) continue;
      const sinceAlert = branch.agent_alerted_at ? (now.getTime() - branch.agent_alerted_at.getTime()) : Infinity;
      if (sinceAlert < AGENT_ALERT_COOLDOWN_MS) continue;

      const recips = await User.find({
        is_active: true,
        $or: [
          { role: 'system_admin' },
          { role: 'branch_manager', $or: [{ managed_branch_ids: branch._id }, { branch_id: branch._id }] },
        ],
      }).select('email').lean();
      const emails = [...new Set(recips.map(r => r.email).filter(Boolean))];
      if (!emails.length) continue;

      const hours = Math.round(downMs / 3600000);
      const sinceTxt = branch.agent_last_seen_at
        ? new Date(branch.agent_last_seen_at).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })
        : 'לא ידוע';
      await dispatchEmail({
        to: emails,
        subject: `🛑 סוכן הנוכחות מנותק — ${branch.name}`,
        html: `<div dir="rtl" style="font-family:Arial,sans-serif">
          <p>הסוכן (Pi) בסניף <b>${branch.name}</b> אינו מדווח כבר כ-<b>${hours} שעות</b> (פעיל לאחרונה: ${sinceTxt}).</p>
          <p><b>החתמות מהשעון לא נקלטות עד שהסוכן יחזור לפעול.</b> ייתכן שה-Pi כבוי, מנותק מהחשמל או מהרשת.</p>
          <p>יש לבדוק את החיבור הפיזי בסניף (חשמל + רשת ל-Pi ולשעון). לאחר חיבור מחדש הנתונים ייקלטו אוטומטית.</p>
        </div>`,
      });
      branch.agent_alerted_at = now;
      await branch.save();
      console.log(`🛑 Agent-silent alert sent for ${branch.name} (${hours}h)`);
    }
  } catch (e) {
    console.error('checkStaleAgents error:', e.message);
  }
}

module.exports = {
  uploadPunches,
  heartbeat,
  pendingCommands,
  commandResult,
  checkStaleAgents,
};
