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
    const israeliIds = [...new Set(
      punches.map(p => p && p.israeli_id).filter(Boolean).map(String)
    )];
    const employees = israeliIds.length
      ? await Employee.find({
          branch_id: branch._id,
          israeli_id: { $in: israeliIds },
          is_active: true,
        }).select('_id israeli_id').lean()
      : [];
    const idMap = new Map(employees.map(e => [e.israeli_id, e._id]));

    let accepted = 0;
    let duplicates = 0;
    let unmatched = 0;
    const errors = [];

    for (const p of punches) {
      if (!p || typeof p.device_user_sn !== 'number' || !p.israeli_id || !p.timestamp) {
        errors.push({ punch: p, reason: 'missing required fields' });
        continue;
      }
      const employeeId = idMap.get(String(p.israeli_id)) || null;
      if (!employeeId) unmatched++;

      try {
        const result = await Punch.updateOne(
          { branch_id: branch._id, device_user_sn: p.device_user_sn },
          {
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
            },
          },
          { upsert: true }
        );
        if (result.upsertedCount === 1) accepted++;
        else duplicates++;
      } catch (e) {
        errors.push({ punch: p, reason: e.message });
      }
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

/**
 * POST /api/agent/:branchId/heartbeat
 * Body: { agent_version, clock_reachable, clock_user_count, clock_log_count, uptime_s }
 */
async function heartbeat(req, res, next) {
  try {
    const branch = req.branch;
    const { agent_version = '' } = req.body || {};
    branch.agent_last_seen_at = new Date();
    if (agent_version) branch.agent_version = agent_version;
    await branch.save();
    res.json({
      ok: true,
      server_time: new Date().toISOString(),
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

module.exports = {
  uploadPunches,
  heartbeat,
  pendingCommands,
  commandResult,
};
