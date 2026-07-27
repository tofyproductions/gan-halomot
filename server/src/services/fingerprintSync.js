/**
 * fingerprintSync — one fingerprint, every branch the employee works at.
 *
 * Background: each branch has its own ZKTeco clock behind its own Pi agent.
 * Registering an employee (`add_user`) only writes her ת"ז + name to a device;
 * the FINGER itself lives on the device that enrolled it. A cross-branch worker
 * therefore ended up able to punch at one branch and not at the others (עדי
 * כוחלני: enrolled at משה דיין, could not punch at קפלן).
 *
 * What this service does:
 *   1. Keeps a server-side copy of the employee's templates
 *      (`Employee.fingerprint`, select:false — biometric data never reaches the
 *      browser), captured with a read-only `export_template` command.
 *   2. Fans that copy out to EVERY branch the employee works at (home branch +
 *      `branch_rates` + `hourly_bonuses`) that actually has a clock, as
 *      `add_user` followed by `import_template`.
 *   3. Re-runs on its own: when the finger is first captured, when an employee
 *      gains a branch, and on a periodic sweep — so nobody has to remember.
 *
 * Every enqueue is de-duplicated against commands already pending/sent for the
 * same employee+branch, so repeated calls never pile work on the agents.
 */

const mongoose = require('mongoose');
const { Employee, Branch, AgentCommand } = require('../models');

// Don't re-try a source branch that had no finger for this employee more often
// than this — a worker with no fingerprint anywhere must not poll forever.
const CAPTURE_RETRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function normalizeId(id) {
  const digits = String(id || '').replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 9 ? digits.padStart(9, '0') : digits;
}

/**
 * Every branch this employee may clock in at, in priority order (home branch
 * first — that's where the finger was most likely enrolled).
 */
function employeeBranchIds(emp) {
  const ids = [];
  const push = (v) => {
    if (!v) return;
    const s = String(v);
    if (!ids.includes(s)) ids.push(s);
  };
  push(emp.branch_id);
  for (const r of emp.branch_rates || []) push(r.branch_id);
  for (const b of emp.hourly_bonuses || []) push(b.branch_id);
  return ids;
}

/** Ids (as strings) of branches that actually have a clock + agent configured. */
async function clockBranchIds() {
  const branches = await Branch.find({ clock_ip: { $nin: [null, ''] } }).select('_id name').lean();
  return { ids: branches.map(b => String(b._id)), byId: Object.fromEntries(branches.map(b => [String(b._id), b])) };
}

/** Branches the employee works at AND that have a clock, home branch first. */
async function relevantBranches(emp) {
  const { ids, byId } = await clockBranchIds();
  return employeeBranchIds(emp).filter(id => ids.includes(id)).map(id => byId[id]);
}

/** Is there already an unfinished command of this type for this worker+branch? */
async function alreadyQueued(branchId, type, israeliId) {
  const existing = await AgentCommand.findOne({
    branch_id: branchId,
    type,
    status: { $in: ['pending', 'sent'] },
    'payload.israeli_id': israeliId,
  }).select('_id').lean();
  return !!existing;
}

/**
 * Make sure the employee's ת"ז exists on that branch's device — `import_template`
 * fails with `user_not_on_device` otherwise. Commands are consumed in creation
 * order, so queuing add_user first is enough.
 */
async function ensureEnrolled(branchId, emp, createdBy = null) {
  const israeliId = normalizeId(emp.israeli_id);
  if (!israeliId) return null;
  if (await alreadyQueued(branchId, 'add_user', israeliId)) return null;
  return AgentCommand.create({
    branch_id: branchId,
    type: 'add_user',
    payload: { israeli_id: israeliId, name: emp.full_name || '', privilege: 0 },
    status: 'pending',
    created_by: createdBy,
  });
}

/** Queue the write of the stored templates onto one branch's clock. */
async function pushTemplatesTo(branchId, emp, createdBy = null) {
  const israeliId = normalizeId(emp.israeli_id);
  const templates = emp.fingerprint?.templates || [];
  if (!israeliId || templates.length === 0) return null;
  if (await alreadyQueued(branchId, 'import_template', israeliId)) return null;

  await ensureEnrolled(branchId, emp, createdBy);
  const cmd = await AgentCommand.create({
    branch_id: branchId,
    type: 'import_template',
    payload: {
      israeli_id: israeliId,
      name: emp.full_name || '',
      templates: templates.map(t => ({ fid: t.fid, valid: t.valid, size: t.size, b64: t.b64 })),
    },
    status: 'pending',
    created_by: createdBy,
  });
  await markBranchSync(emp._id, branchId, { status: 'queued', command_id: cmd._id, finger_count: templates.length });
  return cmd;
}

/** Upsert one entry of `Employee.fingerprint.synced_branches`. */
async function markBranchSync(employeeId, branchId, patch) {
  const emp = await Employee.findById(employeeId).select('+fingerprint');
  if (!emp || !emp.fingerprint) return;
  const row = (emp.fingerprint.synced_branches || []).find(s => String(s.branch_id) === String(branchId));
  if (row) {
    Object.assign(row, patch);
  } else {
    emp.fingerprint.synced_branches.push({ branch_id: branchId, error: '', ...patch });
  }
  await emp.save();
}

/**
 * Pick the branch to read the finger FROM: a branch the employee works at whose
 * clock we haven't recently asked (a failed/empty read is remembered through the
 * export command history, so we walk the list instead of nagging one device).
 */
async function pickCaptureSource(emp, branches) {
  const israeliId = normalizeId(emp.israeli_id);
  const since = new Date(Date.now() - CAPTURE_RETRY_MS);
  const tried = await AgentCommand.find({
    type: 'export_template',
    'payload.israeli_id': israeliId,
    created_at: { $gte: since },
  }).select('branch_id').lean();
  const triedIds = new Set(tried.map(c => String(c.branch_id)));
  return branches.find(b => !triedIds.has(String(b._id))) || null;
}

/** Queue the read-only capture of the employee's finger from one branch. */
async function requestCapture(branchId, emp, createdBy = null) {
  const israeliId = normalizeId(emp.israeli_id);
  if (!israeliId) return null;
  if (await alreadyQueued(branchId, 'export_template', israeliId)) return null;
  return AgentCommand.create({
    branch_id: branchId,
    type: 'export_template',
    payload: { israeli_id: israeliId },
    status: 'pending',
    created_by: createdBy,
  });
}

/**
 * Bring one employee's fingerprint to every branch she works at.
 *
 * With a stored copy: queues add_user + import_template on each branch that is
 * missing it. Without one: queues a read-only export from the most likely
 * source branch — when that comes back, `handleCommandConfirmed` stores it and
 * calls this again, so the fan-out completes on its own.
 *
 * @returns {{ status, queued: Array, waiting_for_capture: boolean, branches: Array }}
 */
async function syncEmployee(employeeId, { createdBy = null, force = false } = {}) {
  const emp = await Employee.findById(employeeId).select('+fingerprint');
  if (!emp) return { status: 'employee_not_found', queued: [], waiting_for_capture: false, branches: [] };
  const israeliId = normalizeId(emp.israeli_id);
  if (!israeliId) return { status: 'no_israeli_id', queued: [], waiting_for_capture: false, branches: [] };

  const branches = await relevantBranches(emp);
  if (branches.length === 0) {
    return { status: 'no_clock_branches', queued: [], waiting_for_capture: false, branches: [] };
  }

  const stored = emp.fingerprint;
  const hasTemplates = !!stored && (stored.templates || []).length > 0;

  if (!hasTemplates) {
    const source = await pickCaptureSource(emp, branches);
    if (!source) {
      return { status: 'no_source_left', queued: [], waiting_for_capture: false, branches: branches.map(b => b.name) };
    }
    const cmd = await requestCapture(source._id, emp, createdBy);
    return {
      status: 'capture_requested',
      queued: cmd ? [{ branch_id: String(source._id), branch_name: source.name, type: 'export_template' }] : [],
      waiting_for_capture: true,
      branches: branches.map(b => b.name),
    };
  }

  // Which branches still need the finger written (or re-written after a newer
  // capture)? The source branch already has it — that's where it came from.
  const capturedAt = stored.captured_at ? new Date(stored.captured_at).getTime() : 0;
  const synced = Object.fromEntries((stored.synced_branches || []).map(s => [String(s.branch_id), s]));
  const targets = branches.filter(b => {
    if (String(b._id) === String(stored.captured_branch_id)) return false;
    if (force) return true;
    const row = synced[String(b._id)];
    if (!row) return true;
    if (row.status === 'failed') return true;
    if (row.status === 'queued') return false;                      // already on its way
    return !row.synced_at || new Date(row.synced_at).getTime() < capturedAt; // stale copy
  });

  const queued = [];
  for (const b of targets) {
    const cmd = await pushTemplatesTo(b._id, emp, createdBy);
    if (cmd) queued.push({ branch_id: String(b._id), branch_name: b.name, type: 'import_template' });
  }
  return {
    status: queued.length ? 'push_queued' : 'up_to_date',
    queued,
    waiting_for_capture: false,
    branches: branches.map(b => b.name),
  };
}

/**
 * Called from the agent's command-result endpoint. An `export_template` that
 * came back with fingers is stored on the employee and immediately fanned out;
 * an `import_template` result closes the loop in `synced_branches`.
 * Never throws — a bookkeeping failure must not fail the agent's report.
 */
async function handleCommandConfirmed(cmd) {
  try {
    if (!cmd || (cmd.type !== 'export_template' && cmd.type !== 'import_template')) return;
    const israeliId = normalizeId(cmd.payload?.israeli_id || cmd.result?.israeli_id);
    if (!israeliId) return;
    const emp = await Employee.findOne({ israeli_id: israeliId }).select('+fingerprint');
    if (!emp) return;

    if (cmd.type === 'import_template') {
      const ok = cmd.status === 'confirmed';
      await markBranchSync(emp._id, cmd.branch_id, {
        status: ok ? 'ok' : 'failed',
        synced_at: ok ? new Date() : null,
        command_id: cmd._id,
        finger_count: ok ? (cmd.result?.verified_fingers ?? (cmd.payload?.templates || []).length) : 0,
        error: ok ? '' : String(cmd.last_error || '').slice(0, 200),
      });
      return;
    }

    // export_template
    if (cmd.status !== 'confirmed') return;
    const templates = (cmd.result?.templates || []).filter(t => t && t.b64);
    if (templates.length === 0) return;   // employee is on that device but has no finger there

    emp.fingerprint = {
      templates: templates.map(t => ({ fid: t.fid, valid: t.valid ?? 1, size: t.size || 0, b64: t.b64 })),
      finger_count: templates.length,
      captured_at: new Date(),
      captured_branch_id: cmd.branch_id,
      synced_branches: [{
        branch_id: cmd.branch_id,
        synced_at: new Date(),
        command_id: cmd._id,
        finger_count: templates.length,
        status: 'ok',
        error: '',
      }],
    };
    await emp.save();
    console.log(`[fingerprint] stored ${templates.length} finger(s) for ${emp.full_name} (${israeliId})`);

    // Now that we hold a copy, push it to every other branch she works at.
    const res = await syncEmployee(emp._id, { createdBy: cmd.created_by || null });
    if (res.queued.length) {
      console.log(`[fingerprint] fan-out for ${emp.full_name}: ${res.queued.map(q => q.branch_name).join(', ')}`);
    }
  } catch (err) {
    console.error('[fingerprint] handleCommandConfirmed failed:', err.message);
  }
}

/**
 * Periodic sweep: every active multi-branch employee gets her finger captured
 * (once) and mirrored to all her branches. Cheap — almost every pass finds
 * nothing to do, since work is de-duplicated against queued commands.
 * Never throws (runs on a timer).
 */
async function sweep({ limit = 40 } = {}) {
  try {
    const { ids: clockIds } = await clockBranchIds();
    if (clockIds.length < 2) return { checked: 0, queued: 0 };   // nothing to mirror to

    const clockObjectIds = clockIds.map(id => new mongoose.Types.ObjectId(id));
    // Multi-branch workers only: someone who works at a single branch has her
    // finger where she needs it.
    const employees = await Employee.find({
      is_active: true,
      israeli_id: { $nin: [null, ''] },
      $or: [
        { 'branch_rates.branch_id': { $in: clockObjectIds } },
        { 'hourly_bonuses.branch_id': { $in: clockObjectIds } },
      ],
    }).select('_id full_name israeli_id branch_id branch_rates hourly_bonuses').limit(limit).lean();

    let queued = 0;
    for (const emp of employees) {
      const res = await syncEmployee(emp._id);
      queued += res.queued.length;
    }
    if (queued) console.log(`[fingerprint] sweep queued ${queued} command(s) over ${employees.length} employee(s)`);
    return { checked: employees.length, queued };
  } catch (err) {
    console.error('[fingerprint] sweep failed:', err.message);
    return { checked: 0, queued: 0, error: err.message };
  }
}

/** Read-only status for the UI (no blobs — just where the finger is). */
async function statusFor(employeeId) {
  const emp = await Employee.findById(employeeId).select('+fingerprint');
  if (!emp) return null;
  const branches = await relevantBranches(emp);
  const synced = Object.fromEntries((emp.fingerprint?.synced_branches || []).map(s => [String(s.branch_id), s]));
  return {
    has_fingerprint: (emp.fingerprint?.templates || []).length > 0,
    finger_count: emp.fingerprint?.finger_count || 0,
    captured_at: emp.fingerprint?.captured_at || null,
    captured_branch_id: emp.fingerprint?.captured_branch_id ? String(emp.fingerprint.captured_branch_id) : null,
    branches: branches.map(b => {
      const row = synced[String(b._id)];
      return {
        branch_id: String(b._id),
        branch_name: b.name,
        status: row?.status || 'missing',
        synced_at: row?.synced_at || null,
        error: row?.error || '',
      };
    }),
  };
}

module.exports = {
  syncEmployee,
  handleCommandConfirmed,
  sweep,
  statusFor,
  relevantBranches,
  employeeBranchIds,
  normalizeId,
};
