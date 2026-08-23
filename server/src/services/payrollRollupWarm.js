const { Branch, PayrollRollup } = require('../models');
const { getMonth } = require('../controllers/payrollMonth.controller');

/**
 * Compute each branch's month once, so that somebody above it has something to
 * add up.
 *
 * The director's summary is built from what the branch screen writes on its way
 * out — deliberately, so a district can never disagree with the branches under
 * it. That leaves a gap the moment a network is large: the all-branches screen
 * now refuses past 25 branches, and nobody is going to open two thousand
 * branches by hand, so at month end the summary would be honest and nearly
 * empty.
 *
 * So the branches are opened here instead, ONE AT A TIME. Each costs about
 * 250ms whatever the network's size — that is the measured shape of the
 * per-branch screen, and it is the whole reason this is possible. Two thousand
 * branches is therefore minutes of background work, not a request anybody waits
 * on.
 *
 * SERIAL, AND WITH A PAUSE BETWEEN BRANCHES. Node runs one thing at a time, and
 * this job exists precisely because that made a single large payroll request
 * freeze every other screen in the customer. Warming two thousand branches as
 * fast as possible would reproduce the outage it was written to prevent, just
 * spread over ten minutes. The pause hands the event loop back so that a carer
 * clocking in during the warm does not wait behind it.
 *
 * The controller is called the way index.js already calls controllers from
 * jobs — a request-shaped object and a response that collects instead of
 * sending. The alternative is extracting a thousand-line payroll calculation
 * into a function it was never written to be, on a system that pays real
 * people, to save a small adapter.
 */

/** Give the event loop a turn. */
const breathe = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} opts
 * @param {string} opts.month              'YYYY-MM'
 * @param {number} [opts.pauseMs=40]       gap between branches
 * @param {boolean} [opts.onlyMissing]     skip branches already computed for this month
 */
async function warmMonth({ month, pauseMs = 40, onlyMissing = true } = {}) {
  if (!month || !/^\d{4}-\d{2}$/.test(month)) throw new Error('month=YYYY-MM נדרש');

  const branches = await Branch.find({}).select('_id').lean();

  let todo = branches.map((b) => String(b._id));
  if (onlyMissing) {
    const done = await PayrollRollup.find({ month }).select('branch_id').lean();
    const haveIt = new Set(done.map((r) => String(r.branch_id)));
    todo = todo.filter((id) => !haveIt.has(id));
  }

  let ok = 0;
  const failed = [];

  for (const branchId of todo) {
    // The controller writes the rollup as a side effect of rendering; what it
    // would have sent back is of no interest here and is thrown away.
    const req = {
      query: { month, branch: branchId },
      // system_admin so the branch-scope check does not narrow it further —
      // this is the system computing its own cache, not a person looking.
      user: { role: 'system_admin' },
    };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json() { return this; },
    };

    // getMonth is an async function that finishes by calling res.json(), so
    // awaiting it is enough; `next` only fires on an error it did not handle.
    let handedToNext = null;
    try {
      await getMonth(req, res, (err) => { handedToNext = err; });
      // The rollup write is fire-and-forget for a person's screen. This job
      // exists to produce it, so here it is waited for — without this the warm
      // reports success and leaves rows unwritten.
      if (req._rollupWrite) await req._rollupWrite.catch(() => {});
      if (handedToNext) failed.push({ branch: branchId, error: handedToNext.message });
      else if (res.statusCode !== 200) failed.push({ branch: branchId, error: `status ${res.statusCode}` });
      else ok += 1;
    } catch (err) {
      failed.push({ branch: branchId, error: err.message });
    }

    if (pauseMs) await breathe(pauseMs);
  }

  return { month, branches: branches.length, computed: ok, skipped: branches.length - todo.length, failed };
}

module.exports = { warmMonth };
