/**
 * Queue a viewer's write for approval, and (Task 5) apply it once approved.
 */
const http = require('http');
const https = require('https');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const {
  approverFor, screenLabelFor, summarizeBody, extractBranchId, viewerMessage,
  isBlockedForViewer, isWriteBlockedForViewer, pathOnly,
} = require('../utils/viewer');

/**
 * Collapse a run of slashes and drop a trailing one — what Express does to a
 * path before matching, MINUS the case folding.
 */
function collapseSlashes(path) {
  const p = String(path || '').replace(/\/{2,}/g, '/');
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

/**
 * The path exactly as the router that receives it will read it.
 * Stored (and replayed) canonical so the record cannot say one thing while
 * the replay does another — `/api/employees/../admin/users` is /api/admin/users,
 * and `/api//employees/e9/` is the same route as `/api/employees/e9`.
 *
 * Case is NOT folded here. Express matches case-insensitively, so folding
 * changed no route — but the stored row is also what the approver reads and
 * what the replay puts on the wire, and a lowercased `/api/TMT/Approve` is a
 * record of a request nobody made. Every CHECK still folds (pathOnly, in
 * applyProposal below and in utils/viewer.js), so `/api/ADMIN/x` is refused
 * exactly as `/api/admin/x` is.
 */
function normalizePath(url) {
  try {
    const u = new URL(String(url || ''), 'http://x');
    return collapseSlashes(u.pathname) + u.search;
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
 *
 * FILING A PROPOSAL IS ITSELF A WRITE, and utils/viewerWriteGuard refuses a
 * write made on a viewer's request that no route gate claimed — which is
 * exactly the request we are here to file. Left alone, the guard would refuse
 * its own proposal and the viewer's change would be lost with a 500 instead of
 * queued. So the whole of it runs OUTSIDE the viewer-write context, for every
 * caller: the 403→202 wrapper in middleware/auth.js, the guard itself, and the
 * error handler. Putting it here rather than at the three call sites means the
 * fourth caller cannot get it wrong.
 */
function propose(req, res, opts = {}) {
  return require('../utils/viewerContext').runOutside(() => fileProposal(req, res, opts));
}

async function fileProposal(req, res, { models } = {}) {
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
    // A replay that never answers would otherwise hold the row in `applying`
    // until the stale sweep releases it, and hold the approver's HTTP request
    // open the whole time. destroy(err) surfaces as 'error' → { status: 0 }.
    request.setTimeout(30000, () => request.destroy(new Error('timeout')));
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
  host = undefined,
} = {}) {
  let target;
  let base;
  try {
    base = new URL(baseUrl);
    target = new URL(String(doc.path || ''), base);
  } catch {
    return { status: 0, ok: false, error: BAD_PATH };
  }
  // Judge the path the way the router that receives it will: `/api//ADMIN/x`
  // and `/api/admin/x` are one route to Express, so one folded form has to
  // answer for both. The wire still carries target.pathname untouched —
  // Express folds it identically at the other end.
  const canon = pathOnly(target.pathname + target.search);
  if (target.origin !== base.origin
    || !(canon === '/api' || canon.startsWith('/api/'))
    || isBlockedForViewer(canon)
    || isWriteBlockedForViewer(canon)) {
    return { status: 0, ok: false, error: BAD_PATH };
  }

  const headers = {
    Authorization: `Bearer ${mintApproverToken(approver, tenantSlug)}`,
    'X-Proposed-Change': String(doc._id),
  };
  // Which customer this replay lands on is decided by the Host header, and
  // `doc.host` came off the VIEWER's request — a header she can set to any
  // value she likes. The approver is here, pressing the button, on a request
  // of her own: her Host is the one that says where this belongs. The stored
  // one is the fallback for a replay with no browser attached (a job, a
  // retry), where there is nothing better to use.
  const replayHost = host || doc.host;
  if (replayHost) headers.Host = replayHost;
  const init = { method: doc.method, headers };
  if (doc.body !== null && doc.body !== undefined && !['GET', 'HEAD'].includes(doc.method)) {
    headers['Content-Type'] = doc.content_type || 'application/json';
    init.body = JSON.stringify(doc.body);
  }
  try {
    const resp = await transport(`${base.origin}${target.pathname}${target.search}`, init);
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
