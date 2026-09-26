'use strict';

const mongoose = require('mongoose');

/**
 * A Mongo-leased lock for scheduled jobs.
 *
 * Every scheduler in index.js is a bare setInterval — which assumes exactly
 * one process. Two ways that assumption breaks in practice:
 *   1. a tick outlasts its interval (a hung Sheets call → overlapping passes
 *      of the same sync, both writing, both advancing the shadow);
 *   2. more than one instance exists (every Render deploy runs old+new side
 *      by side for a window; scaling past one instance makes it permanent).
 * Either way the same job runs twice at once: duplicate children from a
 * double sheet-import, double push notifications, double AI spend on the
 * face scanner.
 *
 * The lease is one atomic findOneAndUpdate: claim the named lock if it is
 * free or its lease expired. Whoever's update matches runs; everyone else
 * skips this tick (the work is recurring — skipping is always safe). The
 * lease has a TTL so a crashed holder never wedges the job forever, and the
 * holder refreshes it only by finishing (release) or dying (expiry).
 *
 * NOT a general mutex: correctness still requires jobs to be idempotent-ish.
 * This only collapses "twice at once" into "once at a time".
 */

const lockSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  holder: { type: String, default: '' },          // pid@host — for debugging
  expires_at: { type: Date, required: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

const JobLock = mongoose.models.JobLock || mongoose.model('JobLock', lockSchema);

const HOLDER = `${process.pid}@${require('os').hostname()}`;

/**
 * Run `fn` under the named lock, or skip silently if another holder has it.
 * @param {string} name     lock name, e.g. 'sheet-sync'
 * @param {number} ttlMs    lease length — MUST comfortably exceed the job's
 *                          worst-case runtime, or a slow-but-alive run loses
 *                          its lease mid-flight and a second run starts.
 * @param {Function} fn     the job body (async)
 * @returns {Promise<{ran: boolean, result?: any}>}
 */
async function withJobLock(name, ttlMs, fn) {
  const now = new Date();
  let claim = null;
  try {
    claim = await JobLock.findOneAndUpdate(
      { name, $or: [{ expires_at: { $lte: now } }, { expires_at: null }] },
      { $set: { holder: HOLDER, expires_at: new Date(now.getTime() + ttlMs) } },
      { new: true, upsert: true },
    );
  } catch (e) {
    // E11000 = the filter matched nothing (lock exists and is HELD) so the
    // upsert tried to insert a duplicate name. That is the normal "someone
    // else has it" answer — skip this tick.
    if (e && e.code === 11000) return { ran: false };
    throw e;
  }
  if (!claim) return { ran: false };
  try {
    const result = await fn();
    return { ran: true, result };
  } finally {
    // Release only OUR lease — never one that expired under us and was
    // re-claimed by someone else while we ran long.
    await JobLock.updateOne(
      { name, holder: HOLDER },
      { $set: { expires_at: new Date(0) } },
    ).catch(() => {});
  }
}

module.exports = { withJobLock, JobLock };
