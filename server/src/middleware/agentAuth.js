const crypto = require('crypto');
const { Branch } = require('../models');

/**
 * Authenticates a Pi agent by matching the per-branch shared secret against
 * the `X-Agent-Secret` header. The branch ID is taken from the URL param.
 *
 * Uses a constant-time comparison to avoid timing-based secret leakage.
 *
 * On success, attaches `req.branch` (Mongoose doc) for downstream handlers.
 */
async function agentAuth(req, res, next) {
  try {
    const { branchId } = req.params;
    const providedSecret = req.headers['x-agent-secret'];

    if (!branchId || !providedSecret) {
      return res.status(401).json({ error: 'missing branch id or agent secret' });
    }

    const branch = await Branch.findById(branchId);
    if (!branch || !branch.is_active) {
      return res.status(404).json({ error: 'branch not found' });
    }
    if (!branch.agent_secret) {
      return res.status(403).json({ error: 'branch has no agent secret configured' });
    }

    const a = Buffer.from(String(providedSecret));
    const b = Buffer.from(String(branch.agent_secret));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'invalid agent secret' });
    }

    req.branch = branch;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { agentAuth };
