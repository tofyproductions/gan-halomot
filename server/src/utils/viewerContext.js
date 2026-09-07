/**
 * "Is the code running right now a viewer's write, and did anybody claim it?"
 *
 * THE PROBLEM THIS SOLVES. middleware/auth.js#decideViewerWrite lets a viewer
 * who holds managed branches continue as a `branch_manager` (rule 3), betting
 * that whatever refuses her — requireRole on a route managers may not use,
 * requireTabWrite's READ_ONLY, a controller's own scope check — will answer
 * 403, and that the wrapper turns that 403 into a proposal. On the 77 staff
 * write routes that carry NO gate at all (branches, suppliers, products,
 * orders, discounts, holidays, activities, archives, gantt, the content bank,
 * contracts, the supply list, recruitment, collections, children,
 * registrations…) nothing ever answers 403 — so the bet is lost silently and
 * she writes. `PUT /api/branches/<somebody else's branch>` renamed it.
 *
 * So the request carries a note saying "this is a viewer's write", and every
 * gate that lets her through ON PURPOSE signs it (`claim`). utils/
 * viewerWriteGuard.js then refuses, at the mongoose layer, any write on a
 * request whose note nobody signed — the database is never touched and the
 * change becomes a proposal instead.
 *
 * ITS OWN STORE, deliberately. platform/context.js carries the current
 * customer's models in an AsyncLocalStorage of its own; the two answer
 * different questions and must be able to be nested, replaced or removed
 * independently. Same pattern, separate store.
 *
 * OUTSIDE A VIEWER'S WRITE THERE IS NO STORE AT ALL. `get()` returns null for
 * every other role, for every read, and for the proposal replay (which runs as
 * the approver), and the guard is then a no-op — that is what keeps this
 * change invisible to the other seven roles.
 */

const { AsyncLocalStorage } = require('async_hooks');

const store = new AsyncLocalStorage();

/**
 * Run `fn` — in practice Express's `next()`, and therefore the whole rest of
 * the request — inside a fresh viewer-write context.
 *
 * Express keeps the async context across `await`s, so a controller five
 * middlewares and three promises later still sees this store.
 */
function runViewerWrite(req, res, fn) {
  const state = {
    req,
    res,
    /** Did a gate deliberately let this viewer through? */
    claimed: false,
    /** Every reason given, in order — the first one is the decisive one. */
    claims: [],
    /** Has a proposal already been filed for this request? */
    proposed: false,
  };
  bindRequestEvents(req, state);
  return store.run(state, fn);
}

/**
 * ONE HOLE THE STORE DOES NOT CROSS BY ITSELF: a body parsed off the socket.
 *
 * AsyncLocalStorage follows the ASYNC path, and a plain EventEmitter listener
 * does not create one — it runs synchronously inside whoever called `emit`.
 * The request body arrives on the socket, so `req.emit('data'/'end')` is called
 * from the HTTP server's own context, and everything hanging off it runs there
 * too. multer is exactly that: it pipes `req` into busboy and calls `next()`
 * from busboy's `finish` handler. Measured, not assumed — an express app with
 * `als.run(state, next)` in a middleware and `multer().single()` on the route
 * sees `als.getStore() === undefined` in the handler.
 *
 * That is not a cosmetic gap. It meant the whole of a multipart request — the
 * controller, and every mongoose write it makes — ran with NO viewer context,
 * so utils/viewerWriteGuard was inert and a viewer's upload to somebody else's
 * branch was written for real on the four upload routes that carry no gate
 * (documents, employment contracts, the manual registration finalize, the
 * תמ"ת price PDF). Re-entering the store around `req.emit` puts the listeners
 * back on the request's own context, and everything after them — the awaits,
 * the writes — inherits it normally.
 *
 * Only `req` is bound, and only for a viewer's write. The response's events are
 * left alone: they fire after the answer, and a write started from one is the
 * fire-and-forget case the guard documents rather than a request to protect.
 *
 * THE BINDING FOLLOWS THE CURRENT STATE, NOT THE FIRST ONE. `req.emit` is
 * wrapped once — wrapping it twice would nest the stores — but the wrapper
 * reads `req.$viewerEmitState` at EMIT time, and that field is re-pointed on
 * every runViewerWrite for this request. Binding the state captured at wrap
 * time instead was a real bug: authMiddleware runs twice on routers that mount
 * it themselves, a second context was created, and req.emit went on resuming
 * multer inside the first — unclaimed — one, so a managed viewer's upload to
 * her own branch was refused. middleware/auth.js#decideViewerWrite now decides
 * once, so there should never be a second state; this keeps the binding honest
 * if one ever appears again.
 */
function bindRequestEvents(req, state) {
  if (!req || typeof req.emit !== 'function') return;
  req.$viewerEmitState = state;
  if (req.$viewerEmitBound) return;
  req.$viewerEmitBound = true;
  const original = req.emit;
  req.emit = function boundEmit(...args) {
    const current = req.$viewerEmitState;
    if (!current) return original.apply(this, args);
    return store.run(current, () => original.apply(this, args));
  };
}

/** The current viewer-write context, or null when there is not one. */
function get() {
  return store.getStore() || null;
}

/**
 * "This write is gated, and the gate said yes."
 *
 * Called by requireRole / requireTab / requireTabWrite / requireBranchScope
 * when they pass a request running under the viewer's manager fallback.
 * Idempotent: the first claim decides, later ones are recorded and change
 * nothing. Returns false outside a viewer write, where there is nothing to
 * claim.
 */
function claim(reason) {
  const s = store.getStore();
  if (!s) return false;
  const text = String(reason || '');
  s.claims.push(text);
  if (!s.claimed) {
    s.claimed = true;
    s.claim_reason = text;
  }
  return true;
}

/**
 * Run `fn` with NO viewer context — used by the guard to file the proposal.
 *
 * Filing one is itself a write (ProposedChange.create), and without this it
 * would hit the very hook that is filing it: the guard would refuse its own
 * proposal, and the viewer's change would vanish instead of queueing.
 */
function runOutside(fn) {
  return store.exit(fn);
}

module.exports = { runViewerWrite, get, claim, runOutside };
