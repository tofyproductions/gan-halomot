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
 *   - AN AGGREGATION PIPELINE THAT WRITES IS NOT COVERED. `aggregate` is
 *     treated as a read here (it almost always is), but a pipeline whose last
 *     stage is `$out` or `$merge` writes a whole collection through that same
 *     "read". Hooking `aggregate` wholesale would refuse every viewer report,
 *     so the line is drawn at the stage list: `grep -rn '\$out\|\$merge'
 *     server/src` finds none today, and one added later would go through
 *     unguarded. If one is ever added, it must either carry a claim or hook
 *     `aggregate` and inspect `this.pipeline()`.
 */

const viewerContext = require('./viewerContext');
const { isMultipart, NO_UPLOAD } = require('./viewer');

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

/**
 * A multipart request cannot become a proposal, so it is refused instead.
 *
 * A ProposedChange stores `body` as JSON and the replay puts that JSON back on
 * the wire. multer has already turned the multipart body into text fields and
 * a Buffer by the time a write reaches mongoose, so filing one here would
 * record `content_type: multipart/form-data; boundary=…` with a JSON body: the
 * approver would approve it, the replay would hand busboy `{"doc_type":"x"}`
 * and the upload would fail — a proposal that can never be applied, and a file
 * silently lost. The ungated upload routes this reaches are POST
 * /api/documents/upload, employmentContracts.routes.js:49,
 * registration.routes.js:43 and branchPricing.routes.js:12.
 *
 * The answer is the same NO_UPLOAD that decideViewerWrite rule 4 and the
 * 403→202 wrapper give (utils/viewer.js owns the text so all three agree).
 * Written the way propose() writes its 202 — straight onto `res` while nothing
 * has been sent yet, which is before the wrapper's silencer can engage (it
 * needs headersSent). The caller has already set `proposed`, so everything
 * after this — a second write, the controller's own reply, the error handler —
 * is silenced exactly as it is after a real proposal.
 */
function refuseUpload(state) {
  if (!state.res.headersSent) state.res.status(403).json(NO_UPLOAD);
}

/** File the viewer's request for approval, from outside the guard's own reach. */
async function fileProposal(state, operation) {
  if (isMultipart(state.req)) return refuseUpload(state);
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
/**
 * The slow half. Only ever entered on a viewer's unclaimed write, i.e. never
 * on any of the other seven roles' requests.
 */
async function refuse(state, operation) {
  if (!state.proposed) {
    state.proposed = true;
    await fileProposal(state, operation);
  }
  throw new ViewerUnclaimedWriteError(operation);
}

/**
 * The fast half, and it is deliberately SYNCHRONOUS.
 *
 * This runs on every write the whole application makes, for every role, for
 * the rest of the process's life — so the "there is no viewer here" answer
 * must cost one AsyncLocalStorage lookup and nothing else: no promise, no
 * async frame, no string built for an operation label nobody will read (the
 * labels are built once, when the plugin attaches the hooks). Returning
 * `undefined` rather than a resolved promise is what mongoose wants from a
 * synchronous pre hook, and it keeps the write on its original tick.
 */
function guard(operation) {
  const state = viewerContext.get();
  if (state === null || state.claimed) return undefined;
  return refuse(state, operation);
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

  // The label is built HERE, once per operation per schema, and closed over —
  // not inside the hook, where it would be a string allocated on every write
  // the application makes and thrown away unread on all but a viewer's.
  for (const op of QUERY_WRITE_OPS) {
    const label = `query:${op}`;
    schema.pre(op, { document: false, query: true }, function () { return guard(label); });
  }
  for (const op of DOCUMENT_WRITE_OPS) {
    const label = `document:${op}`;
    schema.pre(op, { document: true, query: false }, function () { return guard(label); });
  }
  for (const op of MODEL_WRITE_OPS) {
    const label = `model:${op}`;
    schema.pre(op, function () { return guard(label); });
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
