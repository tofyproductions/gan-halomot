const { Branch, AgentCommand } = require('../models');

/**
 * Keep Branch.clock_users honest.
 *
 * That field is the answer to "who is registered on this branch's clock", and
 * two real code paths lean on it: the clock-match dialog an admin uses to tie a
 * device user to an employee, and the fan-out that queues delete_user on every
 * clock a departing employee sits on. Until this job existed nothing ever wrote
 * it after the first time. It was typed by hand out of gan-pi-1 in April 2026
 * and seeded onto משה דיין alone; the other three branches were never filled at
 * all, so their dialogs showed a partial roster and the delete fan-out simply
 * skipped them. By September 2026 the one branch that had been seeded was
 * short by 17 people, and every branch still listed staff who had left.
 *
 * So: ask each clock, once a day, through the agent. The command is read-only
 * on the device and carries no payload.
 *
 * Deliberately cheap and deliberately dumb. One command per branch per day, and
 * never a second one while the first is still in flight — a Pi that is offline
 * must not accumulate a queue of identical roster requests that all land at once
 * when it wakes up.
 */

const IN_FLIGHT = ['pending', 'sent'];

/**
 * Queue a `list_users` on every branch that has a clock.
 * Skips a branch that already has one waiting — see the note above.
 * Never throws: it runs on a timer.
 */
async function tick() {
  try {
    const branches = await Branch.find({
      clock_ip: { $nin: [null, ''] },
    }).select('_id name').lean();

    let queued = 0;
    let skipped = 0;

    for (const b of branches) {
      const waiting = await AgentCommand.findOne({
        branch_id: b._id,
        type: 'list_users',
        status: { $in: IN_FLIGHT },
      }).select('_id').lean();

      if (waiting) { skipped += 1; continue; }

      await AgentCommand.create({
        branch_id: b._id,
        type: 'list_users',
        payload: {},
        status: 'pending',
        created_by: null,
      });
      queued += 1;
    }

    return { branches: branches.length, queued, skipped };
  } catch (err) {
    console.error('[clock-roster] tick failed:', err.message);
    return { branches: 0, queued: 0, skipped: 0, error: err.message };
  }
}

/**
 * Store a confirmed `list_users` result on its branch.
 *
 * Called from the agent's command-result endpoint. Never throws — a
 * bookkeeping failure must not fail the agent's report, exactly as with the
 * fingerprint bookkeeping next to it.
 *
 * An empty roster is REFUSED. A clock that answers "nobody is registered here"
 * is telling us about a device that was wiped or swapped, not about a branch
 * with no staff, and writing that emptiness over a good roster would silently
 * disarm the delete_user fan-out and blank the match dialog. Better to keep
 * yesterday's truth and let the count mismatch show up.
 */
async function storeRoster(cmd) {
  try {
    if (!cmd || cmd.type !== 'list_users' || cmd.status !== 'confirmed') return null;

    const users = Array.isArray(cmd.result?.users) ? cmd.result.users : [];
    if (users.length === 0) {
      console.warn(`[clock-roster] ${cmd.branch_id} answered with an EMPTY roster — keeping the previous one`);
      return null;
    }

    // Normalized on the Pi already (9-digit ת"ז, junk dropped). Re-map anyway so
    // an older agent, or one somebody patches by hand, cannot write a shape the
    // readers do not understand.
    const roster = users
      .map(u => ({
        uid: u.uid,
        user_id: String(u.user_id ?? u.userId ?? '').replace(/\D/g, '').padStart(9, '0'),
        password: String(u.password || ''),
        cardno: u.cardno || 0,
        role: u.role || 0,
      }))
      .filter(u => u.user_id !== '000000000')
      .sort((a, b) => (a.uid || 0) - (b.uid || 0));

    if (roster.length === 0) return null;

    await Branch.updateOne(
      { _id: cmd.branch_id },
      { $set: { clock_users: roster, clock_users_updated_at: new Date() } },
    );
    console.log(`[clock-roster] ${cmd.branch_id}: stored ${roster.length} clock users`);
    return { stored: roster.length };
  } catch (err) {
    console.error('[clock-roster] storeRoster failed:', err.message);
    return null;
  }
}

module.exports = { tick, storeRoster };
