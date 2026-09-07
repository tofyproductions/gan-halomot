/**
 * The last line: a viewer never writes to the database by accident.
 *
 * WHY THIS EXISTS. The viewer's write rule is decided in middleware/auth.js
 * (decideViewerWrite). Rule 3 of it — a viewer who holds managed branches
 * continues the request as a `branch_manager`, and whatever answers 403 next
 * becomes a proposal — only works where something ANSWERS 403. 77 staff write
 * routes carry no requireRole, no requireTab and no requireBranchScope:
 * branches, suppliers, products, orders, discounts, holidays, activities,
 * archives, gantt, the content bank, contracts, the supply list, recruitment,
 * collections, children, registrations. On those the fallback manager simply
 * reached the controller and wrote — `PUT /api/branches/:id` renamed a branch
 * belonging to somebody else and filed nothing.
 *
 * Closing that by attaching a gate to 77 routes is the same bet again: the
 * 78th route, written next month, is ungated too. So the rule moves BELOW the
 * routes, to the only place every write in the application actually passes —
 * mongoose. A viewer's write runs inside utils/viewerContext.js; a gate that
 * lets her through on purpose CLAIMS that context; and any write reaching the
 * driver on an unclaimed viewer request is refused before it touches the
 * database and filed as a proposal instead.
 *
 * THIS IS A FAIL-SAFE, NOT THE DECISION. The primary decision is still
 * decideViewerWrite and the 403→202 wrapper next to it — those give the user a
 * clean 202 with a proposal id, and are what the design document describes.
 * This layer exists for the case nobody remembered, and its job is only to make
 * "she wrote directly" impossible rather than unlikely.
 *
 * KNOWN LIMITS.
 *   - Raw driver writes bypass mongoose middleware entirely
 *     (`Model.collection.updateOne(...)`, `db.collection('x').insertOne(...)`).
 *     There are none in server/src today (grep for `.collection.`), and one
 *     added later would not be covered here.
 *   - Non-database side effects that happen BEFORE the first write still
 *     happen: an email sent, a push delivered, a PDF written to disk, a call
 *     to iCount. The write that would have recorded them is refused, which is
 *     the safe half; the letter is already gone.
 *   - The claim is per REQUEST, not per write. Once a gate has claimed, every
 *     write in that request proceeds — which is correct (a gated route is
 *     trusted to do its own scope checking) but worth saying out loud.
 *   - Reads are untouched: no hook is registered on find / findOne /
 *     countDocuments / distinct / aggregate, so the viewer's "sees everything
 *     the admin sees" rule and the materialize fills on claimed routes are
 *     exactly as they were.
 */

const viewerContext = require('./viewerContext');

/**
 * What mongoose rejects the operation with. Named and coded so the two places
 * that must swallow it — middleware/errorHandler.js and the res wrapper in
 * middleware/auth.js — can recognise it without matching on a message.
 */
class ViewerUnclaimedWriteError extends Error {
  constructor(operation) {
    super('שינוי זה נשמר לאישור ולא בוצע ישירות (כתיבה ללא שער בהרשאת צפייה)');
    this.name = 'ViewerUnclaimedWriteError';
    this.code = 'VIEWER_UNCLAIMED_WRITE';
    this.operation = operation || '';
  }
}

/**
 * Every write operation mongoose 8 lets middleware run on.
 * Deliberately NOT: find, findOne, countDocuments, distinct,
 * estimatedDocumentCount, aggregate, init, validate — a viewer reads freely.
 */
const QUERY_WRITE_OPS = [
  'updateOne', 'updateMany', 'replaceOne',
  'deleteOne', 'deleteMany',
  'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace',
];
const DOCUMENT_WRITE_OPS = ['save', 'deleteOne', 'updateOne'];
const MODEL_WRITE_OPS = ['insertMany', 'bulkWrite'];

/** File the viewer's request for approval, from outside the guard's own reach. */
async function fileProposal(state, operation) {
  // Undo the manager fallback first so the stored row records who really asked
  // (`admin_viewer`), the same way the 403→202 wrapper does before it files.
  if (typeof state.req.viewerUndoFallback === 'function') state.req.viewerUndoFallback();
  // Lazy require: the service loads src/models, and src/models registers this
  // very plugin — requiring it at module scope would be a cycle.
  //
  // propose() runs its own body outside the viewer context (see the service):
  // filing a proposal is a write, and without that it would arrive back here
  // and be refused as unclaimed — the guard eating its own proposal.
  const { propose } = require('../services/proposedChanges.service');
  try {
    state.filed = await propose(state.req, state.res);
  } catch (err) {
    state.file_error = err.message;
    console.error('[viewer] שמירת ההצעה נכשלה', operation, err.message);
    if (!state.res.headersSent) {
      state.res.status(500).json({ error: 'שמירת השינוי לאישור נכשלה', detail: err.message });
    }
  }
}

/**
 * The hook itself.
 *
 * Three outcomes, in order of frequency:
 *   no context      — every other role, every read, the approver's replay: pass.
 *   claimed context — a gated route let this viewer through on purpose: pass.
 *   unclaimed       — file one proposal for the request (202 goes out here) and
 *                     reject the operation, so the driver is never called.
 */
async function guard(operation) {
  const state = viewerContext.get();
  if (!state || state.claimed) return;
  if (!state.proposed) {
    state.proposed = true;
    await fileProposal(state, operation);
  }
  throw new ViewerUnclaimedWriteError(operation);
}

/**
 * The mongoose plugin. Applied to every schema in the process, once.
 *
 * Registered as a GLOBAL plugin before the first model file is required —
 * mongoose bakes a schema's middleware into the model when the model is
 * compiled, so a hook added after `mongoose.model()` never runs at all (it
 * fails silently, which is the worst possible way for a fail-safe to fail).
 */
function viewerWriteGuardPlugin(schema) {
  if (schema.$viewerWriteGuard) return;
  schema.$viewerWriteGuard = true;

  for (const op of QUERY_WRITE_OPS) {
    schema.pre(op, { document: false, query: true }, function () { return guard(`query:${op}`); });
  }
  for (const op of DOCUMENT_WRITE_OPS) {
    schema.pre(op, { document: true, query: false }, function () { return guard(`document:${op}`); });
  }
  for (const op of MODEL_WRITE_OPS) {
    schema.pre(op, function () { return guard(`model:${op}`); });
  }
}

/**
 * Install the plugin globally. Call this BEFORE requiring a single model.
 *
 * If models were already compiled we say so loudly rather than pretend: those
 * models are NOT guarded (see above — hooks added post-compile never fire), and
 * a silent hole in a fail-safe is worse than a noisy one.
 */
function register(mongoose) {
  const already = Object.keys(mongoose.models || {});
  if (already.length > 0) {
    console.error(
      '[viewer] שגיאת סדר טעינה: המודלים הבאים נבנו לפני רישום שומר הכתיבה ולכן אינם מוגנים —',
      already.join(', '),
      '— יש לוודא ש-src/models/index.js נטען לפני כל קובץ מודל.',
    );
  }
  mongoose.plugin(viewerWriteGuardPlugin);
  return mongoose;
}

module.exports = viewerWriteGuardPlugin;
module.exports.register = register;
module.exports.ViewerUnclaimedWriteError = ViewerUnclaimedWriteError;
module.exports.QUERY_WRITE_OPS = QUERY_WRITE_OPS;
module.exports.DOCUMENT_WRITE_OPS = DOCUMENT_WRITE_OPS;
module.exports.MODEL_WRITE_OPS = MODEL_WRITE_OPS;
