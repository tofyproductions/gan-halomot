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
const { toClockName } = require('./clockName.service');

/**
 * The name to write on a device.
 *
 * Latin, always: the clock's name field is 24 bytes and not UTF-8, so a Hebrew
 * name arrives truncated mid-character and unreadable. The stored clock_name
 * wins so a correction sticks; otherwise it is derived on the spot.
 */
function deviceName(emp) {
  return emp.clock_name || toClockName(emp.full_name) || '';
}

// Don't re-try a source branch that had no finger for this employee more often
// than this — a worker with no fingerprint anywhere must not poll forever.
const CAPTURE_RETRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
// How long to wait before re-queueing a write that the target agent rejected.
const FAILED_RETRY_MS = 12 * 60 * 60 * 1000;      // 12 hours
// A queued write whose result never came back is retried after this long.
const QUEUED_STALE_MS = 2 * 60 * 60 * 1000;       // 2 hours

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

  // Already registered on that device — don't add her again. Re-adding is
  // wasteful, and an older agent would allocate a FRESH uid for the same ת"ז,
  // splitting the device record in two. The exception is a device that has
  // since been wiped or swapped, which shows up as an import complaining the
  // user isn't there.
  const added = await AgentCommand.findOne({
    branch_id: branchId,
    type: 'add_user',
    status: 'confirmed',
    'payload.israeli_id': israeliId,
  }).sort({ created_at: -1 }).select('created_at').lean();
  if (added) {
    const gone = await AgentCommand.findOne({
      branch_id: branchId,
      type: 'import_template',
      status: 'failed',
      'payload.israeli_id': israeliId,
      created_at: { $gt: added.created_at },
      last_error: /user_not_on_device/,
    }).select('_id').lean();
    if (!gone) return null;
  }
  return AgentCommand.create({
    branch_id: branchId,
    type: 'add_user',
    payload: { israeli_id: israeliId, name: deviceName(emp), privilege: 0 },
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
      name: deviceName(emp),
      templates: templates.map(t => ({ fid: t.fid, valid: t.valid, size: t.size, b64: t.b64 })),
    },
    status: 'pending',
    created_by: createdBy,
  });
  await markBranchSync(emp._id, branchId, {
    status: 'queued', command_id: cmd._id, finger_count: templates.length, attempted_at: new Date(),
  });
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

/**
 * Every ID the CLOCK might know this worker by — her ת"ז, plus the ones she was
 * enrolled under before it was corrected.
 *
 * A device holds whatever ת"ז it was enrolled with. When a typo is fixed in the
 * system, the clock does NOT hear about it: the finger stays under the old
 * number, and a capture asking for the new one comes back empty from a device
 * that is holding the finger the whole time. `clock_aliases` already exists for
 * exactly this on the punch-ingestion side; the capture side has to read it too.
 */
function clockIdsOf(emp) {
  const ids = [];
  for (const v of [emp.israeli_id, ...(emp.clock_aliases || [])]) {
    const id = normalizeId(v);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Queue the read-only capture of the employee's finger from one branch.
 *
 * `asId` overrides which ת"ז to ask the device for — used when the finger is
 * enrolled under an old, corrected number.
 */
async function requestCapture(branchId, emp, createdBy = null, asId = null) {
  const israeliId = normalizeId(asId || emp.israeli_id);
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
 * Move a worker's clock record from an old ת"ז to her current one.
 *
 * Only the first step is queued here — a read of the finger from the device
 * that holds it, under the OLD number. The rest cannot be queued yet: the
 * templates do not exist server-side until that read comes back, and writing
 * an empty user under the new number would leave her unable to punch at all.
 * `handleCommandConfirmed` continues it the moment the templates land.
 *
 * Nothing is deleted before the finger is safely stored AND written back.
 */
async function migrateClockId(employeeId, { fromId, createdBy = null } = {}) {
  const emp = await Employee.findById(employeeId).select('+fingerprint');
  if (!emp) return { status: 'employee_not_found', queued: [] };
  const oldId = normalizeId(fromId);
  const newId = normalizeId(emp.israeli_id);
  if (!oldId || !newId) return { status: 'missing_id', queued: [] };
  if (oldId === newId) return { status: 'nothing_to_migrate', queued: [] };

  const branches = await relevantBranches(emp);
  if (!branches.length) return { status: 'no_clock_branches', queued: [] };

  // EVERY device holding the old number, not just one.
  //
  // A worker is enrolled on every branch she can punch at, so a wrong ת"ז is
  // wrong on all of them — אדולה was on four. Migrating one leaves the other
  // three holding a record that the punch matcher only reaches through an
  // alias, and that the next sweep will happily refresh. Each branch gets its
  // own capture; `handleCommandConfirmed` migrates each independently, using
  // that device's own uid for the delete.
  const enrolled = await AgentCommand.find({
    type: 'add_user', status: 'confirmed', 'payload.israeli_id': oldId,
  }).select('branch_id').lean();
  const enrolledIds = new Set(enrolled.map(c => String(c.branch_id)));
  const targets = branches.filter(b => enrolledIds.has(String(b._id)));
  // No history of the old number anywhere — ask her home branch, which is
  // where an enrolment nobody recorded is most likely to be.
  if (targets.length === 0) targets.push(branches[0]);

  const queued = [];
  for (const b of targets) {
    const cmd = await requestCapture(b._id, emp, createdBy, oldId);
    if (cmd) queued.push({ branch_id: String(b._id), branch_name: b.name, type: 'export_template' });
  }
  return {
    status: queued.length ? 'capture_requested' : 'already_queued',
    from: oldId,
    to: newId,
    branches: targets.map(b => b.name),
    queued,
  };
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
    // Ask the device for the ת"ז it was actually enrolled with. Where a worker
    // carries an alias, a capture under her corrected number comes back empty
    // from a clock that is holding her finger the whole time.
    const knownAs = await AgentCommand.findOne({
      branch_id: source._id,
      type: 'add_user',
      status: 'confirmed',
      'payload.israeli_id': { $in: clockIdsOf(emp) },
    }).sort({ created_at: -1 }).select('payload.israeli_id').lean();

    const cmd = await requestCapture(source._id, emp, createdBy, knownAs?.payload?.israeli_id || null);
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
    if (row.status === 'failed') {
      // Back off after a failed write. A branch whose Pi runs an agent too old
      // for `import_template` would otherwise be re-queued on every sweep,
      // forever — the fix there is deploying the agent, not retrying faster.
      const last = row.attempted_at ? new Date(row.attempted_at).getTime() : 0;
      return Date.now() - last > FAILED_RETRY_MS;
    }
    if (row.status === 'queued') {
      // Normally still on its way. But a command whose result never came back
      // (agent down, server restarted mid-flight) must not pin the branch as
      // "in progress" forever — after a while, try again.
      const last = row.attempted_at ? new Date(row.attempted_at).getTime() : 0;
      return Date.now() - last > QUEUED_STALE_MS;
    }
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
    // Also by alias: a capture issued under a corrected-away ת"ז belongs to the
    // same worker, and looking her up only by her current one would drop the
    // templates on the floor.
    const emp = await Employee.findOne({
      $or: [{ israeli_id: israeliId }, { clock_aliases: israeliId }],
    }).select('+fingerprint');
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

    if (templates.length === 0) {
      // The employee is on that device but has no finger there.
      //
      // For a normal capture that is the end of it. For a clock-id migration it
      // is not: the device record still carries the wrong ת"ז, and there is no
      // finger to lose by moving it. Guarded on the device explicitly answering
      // `finger_count: 0` — a confirmed read that says "this user has no
      // fingers" — rather than on an empty array, which is also what a hiccup
      // looks like. Deleting on a hiccup would destroy a real fingerprint.
      const currentIdNoFinger = normalizeId(emp.israeli_id);
      const deviceSaysNoFinger = cmd.result?.finger_count === 0;
      if (currentIdNoFinger && currentIdNoFinger !== israeliId && deviceSaysNoFinger) {
        await ensureEnrolled(cmd.branch_id, emp, cmd.created_by || null);
        await AgentCommand.create({
          branch_id: cmd.branch_id,
          type: 'delete_user',
          // The agent deletes by DEVICE uid — it rejects a payload carrying only
          // a ת"ז (`missing uid in payload`). The export we just read is where
          // that uid comes from.
          payload: { uid: cmd.result?.uid, israeli_id: israeliId },
          status: 'pending',
          created_by: cmd.created_by || null,
        });
        console.log(`[fingerprint] clock-id migration ${israeliId} -> ${currentIdNoFinger} (no finger on device) for ${emp.full_name}`);
      }
      return;
    }

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

    // Captured under an OLD ת"ז — so this is a clock-id migration, and the
    // device that answered still holds her under the wrong number. Rewrite her
    // there under the current one and remove the old record.
    //
    // Order matters and the agent consumes commands in creation order: add,
    // then write the finger, then delete. Deleting first would leave her unable
    // to punch in the window between the two, and deleting before the templates
    // were stored would lose the finger outright.
    const currentId = normalizeId(emp.israeli_id);
    if (currentId && currentId !== israeliId) {
      await ensureEnrolled(cmd.branch_id, emp, cmd.created_by || null);
      await pushTemplatesTo(cmd.branch_id, emp, cmd.created_by || null);
      await AgentCommand.create({
        branch_id: cmd.branch_id,
        type: 'delete_user',
        // By DEVICE uid — see the note on the other delete_user above.
        payload: { uid: cmd.result?.uid, israeli_id: israeliId },
        status: 'pending',
        created_by: cmd.created_by || null,
      });
      console.log(`[fingerprint] clock-id migration ${israeliId} -> ${currentId} queued for ${emp.full_name}`);
    }

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
  migrateClockId,
  clockIdsOf,
  handleCommandConfirmed,
  sweep,
  statusFor,
  relevantBranches,
  employeeBranchIds,
  normalizeId,
};
