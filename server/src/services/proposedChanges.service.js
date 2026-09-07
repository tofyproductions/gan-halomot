/**
 * Queue a viewer's write for approval, and (Task 5) apply it once approved.
 */
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

module.exports = { propose };
