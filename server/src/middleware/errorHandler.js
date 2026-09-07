const viewerContext = require('../utils/viewerContext');

function notFoundHandler(req, res, next) {
  res.status(404).json({ error: 'Route not found', path: req.originalUrl });
}

/**
 * A viewer's unclaimed write is not an error, it is a proposal.
 *
 * utils/viewerWriteGuard refuses a write reaching mongoose on a viewer's
 * request that no route gate claimed: it files the ProposedChange, answers 202
 * itself, and then rejects the operation so the driver is never called. The
 * controller sees that rejection as a failed query and does what controllers
 * do — `next(err)`, and it arrives here. The user has already been told the
 * truth; logging a stack trace and trying to answer 500 on top of a sent
 * response would only add noise and an ERR_HTTP_HEADERS_SENT.
 *
 * The headers-not-sent branch is the belt to that braces: if the guard somehow
 * threw before its own 202 went out, the change is still filed here rather
 * than lost — once, guarded by the context's `proposed` flag.
 */
function handleUnclaimedViewerWrite(err, req, res) {
  const ctx = viewerContext.get();
  console.info('[viewer] unclaimed write proposed', req.method, String(req.originalUrl || '').split('?')[0]);
  if (res.headersSent) return true;
  if (ctx && ctx.proposed) {
    // Filed, but nothing answered — say what happened without inventing an id.
    res.status(202).json({
      proposed: true,
      message: 'השינוי נשמר וממתין לאישור',
    });
    return true;
  }
  if (ctx) ctx.proposed = true;
  // Undo the manager fallback before filing, exactly as the guard and the
  // 403→202 wrapper do. Without it the stored row says the request came from a
  // `branch_manager` — the role the fallback borrowed — and the approver reads
  // a proposal nobody made.
  if (typeof req.viewerUndoFallback === 'function') req.viewerUndoFallback();
  // Lazy require: the service loads src/models.
  const { propose } = require('../services/proposedChanges.service');
  propose(req, res).catch((e) => {
    console.error('[viewer] propose failed', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'שמירת השינוי לאישור נכשלה', detail: e.message });
  });
  return true;
}

function errorHandler(err, req, res, _next) {
  if (err && err.code === 'VIEWER_UNCLAIMED_WRITE') {
    if (handleUnclaimedViewerWrite(err, req, res)) return;
  }

  console.error('Error:', err.message);
  if (process.env.NODE_ENV !== 'production') console.error(err.stack);

  const status = err.status || 500;
  res.status(status).json({
    error: err.message || 'Internal server error',
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  });
}

module.exports = { notFoundHandler, errorHandler };
