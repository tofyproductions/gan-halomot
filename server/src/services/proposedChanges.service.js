/**
 * Queue a viewer's write for approval, and (Task 5) apply it once approved.
 */
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const {
  approverFor, screenLabelFor, summarizeBody, extractBranchId, viewerMessage,
} = require('../utils/viewer');

function defaultModels() {
  // Lazy: the models index opens mongoose, which the tests do not want.
  return require('../models');
}

/**
 * Save the request as a ProposedChange and answer 202.
 * Returns the saved document. `models` is injectable for tests.
 */
async function propose(req, res, { models } = {}) {
  const M = models || defaultModels();
  // Typed ObjectId on the document: a body carrying anything else would make
  // create() throw, and a bad branch id is not a reason to lose the request.
  const raw = extractBranchId(req);
  const branchId = /^[0-9a-fA-F]{24}$/.test(raw || '') ? raw : null;
  let branchName = '';
  if (branchId && M.Branch && typeof M.Branch.findById === 'function') {
    try {
      const b = await M.Branch.findById(branchId).select('name').lean();
      branchName = b?.name || '';
    } catch { /* the name is decoration */ }
  }
  const approver = approverFor(req.originalUrl);
  const doc = await M.ProposedChange.create({
    requested_by: req.user?.id || null,
    requested_by_name: req.user?.full_name || '',
    requested_role: req.user?.role || '',
    method: String(req.method || '').toUpperCase(),
    path: req.originalUrl || '',
    host: req.headers?.host || '',
    body: req.body ?? null,
    content_type: req.headers?.['content-type'] || 'application/json',
    screen_label: screenLabelFor(req.originalUrl),
    summary: summarizeBody(req.body),
    branch_id: branchId,
    branch_name: branchName,
    approver,
    status: 'pending',
  });
  if (!res.headersSent) {
    res.status(202).json({
      proposed: true,
      id: String(doc._id),
      approver,
      message: viewerMessage(approver),
    });
  }
  return doc;
}

/**
 * A token for one replay: the approver's identity, five minutes, flagged.
 * Minted here rather than borrowed from the approver's own session so the
 * replay can run from a job later without a browser attached.
 */
function mintApproverToken(user, tenantSlug) {
  const payload = {
    id: user.id || user._id,
    email: user.email,
    full_name: user.full_name,
    role: user.role,
    branch_id: user.branch_id || null,
    managed_branch_ids: (user.managed_branch_ids || []).map(String),
    replay: true,
    tenant: tenantSlug,
  };
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: 300 });
}

/**
 * Re-issue the stored request against this server as the approver.
 * Returns { status, ok, error } and never throws. Does not touch the DB.
 */
async function applyProposal(doc, approver, {
  fetchImpl = global.fetch, baseUrl = `http://127.0.0.1:${env.PORT}`, tenantSlug = undefined,
} = {}) {
  const headers = {
    Authorization: `Bearer ${mintApproverToken(approver, tenantSlug)}`,
    'X-Proposed-Change': String(doc._id),
  };
  if (doc.host) headers.Host = doc.host;
  const init = { method: doc.method, headers };
  if (doc.body !== null && doc.body !== undefined && !['GET', 'HEAD'].includes(doc.method)) {
    headers['Content-Type'] = doc.content_type || 'application/json';
    init.body = JSON.stringify(doc.body);
  }
  try {
    const resp = await fetchImpl(`${baseUrl}${doc.path}`, init);
    const text = await resp.text();
    const ok = resp.status >= 200 && resp.status < 300;
    let error = '';
    if (!ok) {
      try { error = JSON.parse(text)?.error || text; } catch { error = text; }
    }
    return { status: resp.status, ok, error };
  } catch (err) {
    return { status: 0, ok: false, error: err.message };
  }
}

module.exports = { propose, applyProposal, mintApproverToken };
