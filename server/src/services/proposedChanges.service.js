/**
 * Queue a viewer's write for approval, and (Task 5) apply it once approved.
 */
const http = require('http');
const https = require('https');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const {
  approverFor, screenLabelFor, summarizeBody, extractBranchId, viewerMessage,
  isBlockedForViewer, isWriteBlockedForViewer,
} = require('../utils/viewer');

/**
 * The path exactly as a client would put it on the wire.
 * Stored (and replayed) normalized so the record cannot say one thing while
 * the replay does another — `/api/employees/../admin/users` is /api/admin/users.
 */
function normalizePath(url) {
  try {
    const u = new URL(String(url || ''), 'http://x');
    return u.pathname + u.search;
  } catch {
    return String(url || '');
  }
}

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
    path: normalizePath(req.originalUrl),
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

const BAD_PATH = 'נתיב לא חוקי להפעלה חוזרת';

/**
 * The default way a replay reaches the wire.
 *
 * Not `fetch`: undici owns the Host header and silently overwrites whatever we
 * set with the connection's own authority, so on the platform every replay
 * looked like it arrived at 127.0.0.1 and tenant resolution fell to the default
 * connection. `http.request` sends the Host we give it. Contract is the small
 * slice of fetch we use: `async (url, init) => ({ status, text: async () => string })`.
 */
function defaultTransport(url, init = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const headers = { ...(init.headers || {}) };
    if (init.body !== undefined && init.body !== null) {
      headers['Content-Length'] = Buffer.byteLength(init.body);
    }
    const request = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: init.method || 'GET',
      headers,
    }, (resp) => {
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: resp.statusCode, text: async () => text });
      });
      resp.on('error', reject);
    });
    request.on('error', reject);
    if (init.body !== undefined && init.body !== null) request.write(init.body);
    request.end();
  });
}

/**
 * Re-issue the stored request against this server as the approver.
 * Returns { status, ok, error } and never throws. Does not touch the DB.
 *
 * The stored path is re-checked here and not trusted: the row was written by a
 * viewer's request and is about to be replayed with an approver's authority, so
 * it has to land on this server, under /api, outside the viewer's blocked areas
 * — the gate that first saw the request is not the gate that sends it.
 */
async function applyProposal(doc, approver, {
  transport = defaultTransport, baseUrl = `http://127.0.0.1:${env.PORT}`, tenantSlug = undefined,
} = {}) {
  let target;
  let base;
  try {
    base = new URL(baseUrl);
    target = new URL(String(doc.path || ''), base);
  } catch {
    return { status: 0, ok: false, error: BAD_PATH };
  }
  if (target.origin !== base.origin
    || !target.pathname.startsWith('/api/')
    || isBlockedForViewer(target.pathname)
    || isWriteBlockedForViewer(target.pathname)) {
    return { status: 0, ok: false, error: BAD_PATH };
  }

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
    const resp = await transport(target.toString(), init);
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

module.exports = { propose, applyProposal, mintApproverToken, defaultTransport };
