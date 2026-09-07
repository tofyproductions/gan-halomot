const jwt = require('jsonwebtoken');
const env = require('../config/env');
const {
  isRead, isViewer, isBlockedForViewer, isWriteBlockedForViewer, isMultipart, pathOnly,
  startsWithPrefix, NO_UPLOAD,
} = require('../utils/viewer');
const { ADMIN_VIEWER } = require('../constants/roles');
const viewerContext = require('../utils/viewerContext');

/**
 * A valid signature is not the same as "issued for this customer".
 *
 * Every customer's tokens are signed with the same key, so verify() alone says
 * only that WE minted it — not for whom. Pointed at another customer's address
 * the token still verifies, the resolver has already opened that customer's
 * database, and the reply is somebody else's children. The claim is stamped at
 * login and has to match the customer the request resolved to.
 *
 * On a single-customer server there is no tenant on the request and no claim in
 * the token, and this is a pass-through.
 */
function sameTenant(req, decoded) {
  if (!req.tenant) return true;
  return decoded && decoded.tenant === req.tenant.slug;
}

/**
 * Prefixes where a viewer's read must stay a viewer's read.
 *
 *   /api/admin — she may not read it at all, and the refusal is viewerGate's
 *     (isBlockedForViewer). Swapping the role here would hand her the admin
 *     screens through the front door, so the swap simply does not happen
 *     there and the existing gate still answers 403.
 *   /api/auth  — /me and friends are how the CLIENT learns who it is talking
 *     to. Handing it 'system_admin' would light up every write button in the
 *     menu for somebody who may not press one. The real role must survive.
 */
const NO_ROLE_SWAP_PREFIXES = ['/api/admin', '/api/auth'];

const DENIED = { error: 'אין לך הרשאה לפעולה זו' };

/**
 * Queue this write for approval. Lazy require: the service loads the models.
 *
 * MARKS THE CONTEXT FIRST. Under rule 3 the rest of the request runs inside a
 * viewer-write context (utils/viewerContext), and `proposed` is the single flag
 * that says "this request has already become a proposal". The write guard sets
 * it before it files; this path — a gate or controller answering 403, converted
 * to a 202 above — must set it too, or the two would disagree:
 *   - a write reaching mongoose AFTER the conversion would find `proposed`
 *     false and file a SECOND proposal for the same request, and
 *   - `silenced()` below would never engage, so the controller's own reply on
 *     top of the 202 would throw ERR_HTTP_HEADERS_SENT.
 * Already-proposed means the request is answered: do nothing at all.
 */
function proposeInstead(req, res) {
  const ctx = viewerContext.get();
  if (ctx) {
    if (ctx.proposed) return undefined;
    ctx.proposed = true;
  }
  const { propose } = require('../services/proposedChanges.service');
  return propose(req, res).catch((err) => {
    console.error('[viewer] propose failed', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'שמירת השינוי לאישור נכשלה', detail: err.message });
  });
}

/**
 * Under the manager fallback (decideViewerWrite below), whatever answers 403
 * is saying "not one of your branches" — a controller's scope check,
 * requireRole on a route managers may not use, requireTabWrite's READ_ONLY. For a viewer that is not a refusal — it is the
 * case that goes to approval. Swap res.json once; anything but a 403 passes
 * through untouched, and an upload stays refused because a file cannot be
 * stored for later.
 *
 * Whatever the outcome, the wrapper undoes the fallback (role back to
 * admin_viewer, viewerFallback cleared) before the response goes out — a
 * controller that answers 200 under the fallback must not leave the rest of
 * the request thinking it is still a branch manager. `req.viewerUndoFallback`
 * exposes that undo so the write guard can do the same before it files.
 *
 * SECOND JOB — swallowing what comes after a proposal. utils/viewerWriteGuard
 * refuses an unclaimed write at the mongoose layer: it files the proposal,
 * answers 202 itself, and then REJECTS the operation so the database is never
 * touched. The controller sees that rejection as an ordinary failure and tries
 * to answer — `next(err)` into the error handler, or its own
 * `res.status(500).json(...)`. Both would land on a response that has already
 * gone out and throw ERR_HTTP_HEADERS_SENT. So once a proposal has been filed
 * AND answered, res.status/json/send/end become no-ops that return `res`.
 * Before that moment they are untouched — which is what lets propose() write
 * its own 202 through them.
 */
function convert403ToProposal(req, res) {
  const originalJson = res.json.bind(res);
  const originalSend = typeof res.send === 'function' ? res.send.bind(res) : null;
  const originalEnd = typeof res.end === 'function' ? res.end.bind(res) : null;
  const originalStatus = res.status.bind(res);

  // headersSent is the "already answered" half; the context flag is the "this
  // was a proposal, not a real reply" half. Both, or we would be silencing an
  // ordinary controller response.
  const silenced = () => res.headersSent && viewerContext.get()?.proposed === true;

  let undone = false;
  const undo = () => {
    if (undone) return;
    undone = true;
    req.user.role = ADMIN_VIEWER;
    delete req.viewerFallback;
  };
  req.viewerUndoFallback = undo;

  let converted = false;
  res.status = function (code) {
    if (silenced()) return res;
    return originalStatus(code);
  };
  if (originalSend) res.send = function (...args) { return silenced() ? res : originalSend(...args); };
  if (originalEnd) res.end = function (...args) { return silenced() ? res : originalEnd(...args); };
  res.json = function (body) {
    if (silenced()) return res;
    undo();
    // `converted` keeps propose()'s own 202 — which comes back through here —
    // from being read as a fresh reply to convert.
    if (converted || res.statusCode !== 403 || res.headersSent) return originalJson(body);
    converted = true;
    if (isMultipart(req)) return originalJson(NO_UPLOAD);
    res.statusCode = 200;
    proposeInstead(req, res);
    return res;
  };
}


/**
 * Prefixes where a viewer's WRITE is left alone.
 *
 *   /api/auth — her own account. Choosing a password, logging out, enrolling
 *     a passkey: proposing those to the admin would be absurd, and
 *     set-password is the ONE write a must_change_password token exists to
 *     make.
 */
const NO_WRITE_GATE_PREFIXES = ['/api/auth'];

/**
 * On a WRITE, a viewer never writes — decided once, here, for every route.
 *
 * This used to live in requireRole/requireTab, which meant it only ran on a
 * route that carried one of them. 77 staff write routes carry neither
 * (branches, suppliers, products, orders, discounts, holidays, activities,
 * registrations, collections, children, archives, gantt, the content bank,
 * contracts, the supply list, recruitment), and on those the viewer simply
 * wrote: PUT /api/branches/:id answered 200 and no proposal was ever filed.
 * A rule that depends on somebody remembering to attach a gate is not the
 * rule — so it moves next to the read swap, where every authenticated request
 * already passes exactly once.
 *
 * In order:
 *   1. /api/auth — untouched (above).
 *   2. /api/admin, /api/proposed-changes — 403, and no proposal. Deciding a
 *      proposal is not a thing to propose.
 *   3. She holds managed branches → the request continues as a branch_manager
 *      (this request only; the JWT is untouched) with the 403→202 wrapper
 *      installed. requireRole then sees `branch_manager`: a route that allows
 *      managers passes and the controller's own scope check decides; a route
 *      that does not answers 403 — and so does requireTabWrite, and so does a
 *      controller refusing a branch that is not hers. Every one of those
 *      becomes a proposal, which is the design's "never a hard error".
 *
 *      ...and where NOTHING answers 403 — the 77 staff write routes that carry
 *      no gate at all — the bet above has nothing to win with. So the rest of
 *      the request runs inside a viewer-write context (utils/viewerContext):
 *      every gate that lets her through claims it, and utils/viewerWriteGuard
 *      refuses any mongoose write on a context nobody claimed, filing it as a
 *      proposal before the database is touched.
 *   4. No managed branches → an upload is refused (a file cannot be queued),
 *      anything else is filed for approval on the spot.
 *
 * Returns true when it has taken the request over — either it answered, or it
 * called `next` itself inside the context. The caller must not call next().
 */
function decideViewerWrite(req, res, next) {
  if (!isViewer(req.user) || isRead(req)) return false;
  const path = pathOnly(req.originalUrl);
  if (NO_WRITE_GATE_PREFIXES.some(p => startsWithPrefix(path, p))) return false;
  if (isBlockedForViewer(path) || isWriteBlockedForViewer(path)) {
    res.status(403).json(DENIED);
    return true;
  }
  // From here the request is decided. The flag says so, so viewerGate below —
  // kept as a fallback for a router mounted without this middleware — does not
  // decide it a second time and file the change twice.
  req.viewerHandled = true;
  if ((req.user.managed_branch_ids || []).length > 0) {
    // `actual_role` on the write for the same reason it is set on the read:
    // a handful of places must still be able to tell who this really is.
    // payrollMonth#createChangeRequest is the one that matters — the design
    // says a viewer stages payroll rows for EVERY branch, and it recognises
    // her by role. Under the fallback the role says branch_manager, so the
    // truth has to travel beside it.
    req.user.actual_role = ADMIN_VIEWER;
    req.user.role = 'branch_manager';
    req.viewerFallback = true;
    convert403ToProposal(req, res);
    // The whole rest of the request runs in here — Express carries the async
    // context across every await, so the controller five middlewares later is
    // still inside it and so is the mongoose write it makes.
    viewerContext.runViewerWrite(req, res, () => next());
    return true;
  }
  if (isMultipart(req)) {
    res.status(403).json(NO_UPLOAD);
    return true;
  }
  proposeInstead(req, res);
  return true;
}

/**
 * On a READ, a viewer IS the admin.
 *
 * The design says the viewer "sees everything the admin sees" — every list,
 * dashboard, payroll table and payslip, across all branches. That rule lives
 * in utils/branch-scope.js#resolveBranchScope, but 36 inline
 * `role === 'system_admin'` tests across 17 controllers never ask it: each
 * scopes its own query by role and quietly confines the viewer to one branch,
 * or drops columns she is entitled to see. Sweeping all 36 would be a change
 * in 17 files that the 37th new one silently breaks again.
 *
 * So the swap is made once, here, where every request already passes: on a
 * read the token's role becomes 'system_admin' and the true role is kept as
 * `actual_role` for the handful of places that must still tell the two apart
 * (her own proposals list and its badge, her own payroll change requests).
 * The WRITE is decided next door, in decideViewerWrite above.
 */
function presentViewerAsAdminForReads(req) {
  if (!isViewer(req.user) || !isRead(req)) return;
  const path = pathOnly(req.originalUrl);
  const blocked = NO_ROLE_SWAP_PREFIXES.some(p => startsWithPrefix(path, p));
  if (blocked) return;
  req.user.actual_role = ADMIN_VIEWER;
  req.user.role = 'system_admin';
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, env.JWT_SECRET);
    if (!sameTenant(req, decoded)) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // A support session may look at everything and change nothing. Fixing a
    // customer's payroll while signed in as one of their managers leaves a
    // record saying the manager did it, and no support call is worth that —
    // when something must change, the customer changes it while we watch.
    //
    // Enforced on the METHOD rather than on a list of routes, because a list
    // is a thing somebody forgets to add to. Anything that is not a read is
    // refused, and the message says why rather than looking like a bug.
    if (decoded.support && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      return res.status(403).json({
        error: 'זו כניסת תמיכה — אפשר לצפות בכל המסכים, אבל לא לשנות דבר.',
        support_by: decoded.support_by || null,
      });
    }

    /**
     * A password somebody else chose is good for exactly one thing: choosing
     * one. Until then every other request is refused.
     *
     * A client-side prompt would be a screen with a close button, and the
     * temporary password — read down a telephone, or sent in a text message
     * that stays in an inbox — would go on working. Whitelisted by route
     * rather than by method, because the whole point is that this token may
     * write ONE thing.
     */
    if (decoded.must_change_password) {
      // originalUrl, not req.path: this middleware runs inside many routers and
      // req.path is relative to whichever one mounted it, so a '/me' somewhere
      // else would let the restriction slip.
      const path = (req.originalUrl || '').split('?')[0];
      const allowed = ['/api/auth/set-password', '/api/auth/me', '/api/auth/logout'].includes(path);
      if (!allowed) {
        return res.status(403).json({
          error: 'הסיסמה הזו זמנית — צריך לבחור סיסמה חדשה לפני שממשיכים.',
          must_change_password: true,
        });
      }
    }

    req.user = decoded;
    presentViewerAsAdminForReads(req);
    if (decideViewerWrite(req, res, next)) return;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Optional auth - attaches user if token present, continues if not.
 *
 * A token that IS present gets the same treatment as under authMiddleware:
 * a viewer's read is the admin's read, and her write is decided rather than
 * performed. A route that lets anonymous callers through is not a route that
 * lets a viewer write.
 */
function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return next();
  }
  let decoded = null;
  try {
    decoded = jwt.verify(header.split(' ')[1], env.JWT_SECRET);
  } catch { return next(); }
  if (!sameTenant(req, decoded)) return next();
  req.user = decoded;
  presentViewerAsAdminForReads(req);
  if (decideViewerWrite(req, res, next)) return;
  next();
}

/**
 * The manager-fallback write logic, shared by requireRole and a tab granted
 * by override in requireTab: as a branch manager when `roles` allows managers
 * and the viewer has managed branches (the controller's own scope check then
 * decides, and its 403 becomes a proposal); refused for uploads; queued for
 * approval otherwise.
 */
function viewerWriteGate(req, res, next, roles) {
  // authMiddleware decided this request already (decideViewerWrite) and left
  // the flag behind. Either it answered — in which case nothing here ever runs
  // — or it swapped the role to branch_manager, in which case isViewer() is
  // false and viewerGate never reaches this line. Arriving anyway means a
  // caller invoked the gate on a request that was refused upstream, so the
  // answer is the refusal, not a second proposal on top of the first.
  if (req.viewerHandled) return res.status(403).json(DENIED);
  if (isWriteBlockedForViewer(req.originalUrl)) return res.status(403).json(DENIED);
  const managed = req.user.managed_branch_ids || [];
  if (roles.includes('branch_manager') && managed.length > 0) {
    req.user.role = 'branch_manager';
    req.viewerFallback = true;
    convert403ToProposal(req, res);
    return next();
  }
  if (isMultipart(req)) return res.status(403).json(NO_UPLOAD);
  return proposeInstead(req, res);
}

/**
 * The viewer role ("מנהל מערכת - לצפייה בלבד") is decided here and only here
 * — requireRole and requireTab below both call this instead of knowing the
 * rule themselves:
 *   reads  — wherever a system admin may read, except /api/admin;
 *   writes — see viewerWriteGate; refused for /api/admin and for uploads.
 *
 * Both halves of that rule are now applied by authMiddleware itself — the
 * read swap (presentViewerAsAdminForReads) and the write decision
 * (decideViewerWrite) — before any route runs. So this is a FALLBACK: it is
 * reached only where the swap deliberately did not happen (under /api/admin,
 * which isBlockedForViewer refuses first), or from a caller that never went
 * through authMiddleware — a router mounted without it, and the unit tests,
 * which do exactly that. It is kept because a gate that depends on an earlier
 * middleware having run is a gate that opens the day somebody mounts a route
 * without it; `req.viewerHandled` keeps the two from deciding twice.
 * Every other role passes through untouched: this returns false and the
 * caller runs its own logic.
 *
 * Returns true when it handled the request (responded, or called next()
 * itself) — the caller must not do anything further in that case.
 */
function viewerGate(req, res, next, roles) {
  if (!isViewer(req.user)) return false;
  if (isBlockedForViewer(req.originalUrl)) {
    res.status(403).json(DENIED);
    return true;
  }
  if (isRead(req)) {
    if (roles.includes('system_admin') || roles.includes(ADMIN_VIEWER)) {
      next();
    } else {
      res.status(403).json(DENIED);
    }
    return true;
  }
  viewerWriteGate(req, res, next, roles);
  return true;
}

/**
 * Screen-based access control, matching what the menu actually grants.
 *
 * requireRole below asks only "what is your role", and the app's permissions
 * screen does not work that way: a tab can be granted to one person, or to a
 * whole role, by id. So a back-office employee handed רישום לאמונה saw the
 * menu item, clicked it, and was thrown back to the dashboard — the menu said
 * yes and the route said no, because they were two different rules.
 *
 * This is the server half of that one rule, in the same precedence the client
 * uses (client/src/config/tabs.js): per-user override, then role-wide
 * override, then the role defaults passed in here. All of it rides on the JWT
 * already, so no extra lookup.
 *
 * The viewer rides the same precedence: a per-user or role-wide *removal*
 * still 403s her, same as anyone else. A per-user or role-wide *grant* opens
 * the tab to her too — reads pass outright, writes still go through
 * viewerWriteGate with `defaultRoles` as the allowed-roles list, because a
 * granted screen is not the same permission as acting for a branch that
 * is not hers. When no override decides either way, viewerGate applies the
 * same reads/writes rule it applies for requireRole, with `defaultRoles` as
 * the role list.
 *
 * Usage: requireTab('clicktac', 'system_admin', 'accountant')
 */
function requireTab(tabId, ...defaultRoles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const u = req.user;
    const has = (list) => Array.isArray(list) && list.includes(tabId);

    const tabGranted = () => {
      // Under the manager fallback isViewer() is already false, so this is the
      // line that lets a fallback viewer through on a tab somebody granted her.
      // That is a deliberate yes, so it claims the write (see viewerContext).
      if (!isViewer(u)) {
        if (req.viewerFallback) viewerContext.claim(`requireTab:${tabId}:override`);
        return next();
      }
      // A tab handed to her on the permissions screen is not a key to
      // /api/admin. viewerGate refuses the blocked prefixes before anything
      // else; the override path has to do the same, on the read as well as
      // on the write, or a single role-wide grant reopens them.
      if (isBlockedForViewer(req.originalUrl)) return res.status(403).json(DENIED);
      if (isRead(req)) return next();
      return viewerWriteGate(req, res, next, defaultRoles);
    };

    if (has(u.tab_overrides_remove)) return res.status(403).json(DENIED);
    if (has(u.tab_overrides_add)) return tabGranted();
    if (has(u.role_tab_remove)) return res.status(403).json(DENIED);
    if (has(u.role_tab_add)) return tabGranted();
    if (defaultRoles.includes(u.role)) {
      if (req.viewerFallback) viewerContext.claim(`requireTab:${tabId}`);
      return next();
    }
    if (viewerGate(req, res, next, defaultRoles)) return;
    return res.status(403).json(DENIED);
  };
}

/**
 * Seeing a screen and acting on it are two different grants.
 *
 * requireTab above opens a screen to whoever the permissions screen handed it
 * — which is what a back-office manager needs to READ רישום לאמונה. It is not
 * what she should have to upload a ministry file, undo one, or turn seventy
 * children into registrations. Until the app has a permission of its own for
 * that, acting stays with the roles that always had it, and a granted tab
 * without one of those roles is read-only.
 *
 * Both must pass: the tab (so revoking it revokes everything) and the role.
 * A viewer reaches this check only under the branch_manager fallback, and
 * only when `roles` does not include managers — in which case the READ_ONLY
 * 403 below is exactly the refusal that authMiddleware's wrapper turns into a
 * proposal, which is what the design asks for. For the seven ordinary roles
 * it is the plain refusal it has always been.
 *
 * Usage: requireTabWrite('clicktac', 'system_admin', 'accountant')
 */
function requireTabWrite(tabId, ...roles) {
  const tabGate = requireTab(tabId, ...roles);
  return (req, res, next) => tabGate(req, res, () => {
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({
        error: 'יש לך הרשאת צפייה בלבד במסך זה',
        code: 'READ_ONLY',
      });
    }
    if (req.viewerFallback) viewerContext.claim(`requireTabWrite:${tabId}`);
    next();
  });
}

/**
 * Role-based access control middleware factory
 * Usage: requireRole('system_admin', 'branch_manager')
 *
 * The viewer decision itself lives in viewerGate, shared with requireTab.
 * Every other role: the plain list check, as before.
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (viewerGate(req, res, next, roles)) return;
    if (!roles.includes(req.user.role)) {
      return res.status(403).json(DENIED);
    }
    // A fallback viewer reaching this line is a viewer whose route names
    // `branch_manager` among its roles — the gate said yes on purpose, so the
    // write guard stands down for the rest of the request.
    if (req.viewerFallback) viewerContext.claim(`requireRole:${roles.join('|')}`);
    next();
  };
}

/**
 * "May this user act for a branch?" — a capability, not a job title.
 *
 * Roles alone answered this badly. An existing employee promoted to run a
 * branch by being GIVEN BRANCHES (managed_branch_ids, which the User model
 * already calls the source of truth for what she may see) still carried her
 * old role, so a role check refused her — with "אין לך הרשאה לפעולה זו" and
 * nothing about why, on a screen she could see in the menu.
 *
 * So: accountants and admins always pass, a branch_manager passes, and anyone
 * holding managed branches passes regardless of the label on her role. Someone
 * with neither is refused with a message that says which of the two is missing,
 * because the fix differs — and a stale token is refused too, which is its own
 * common cause worth naming.
 */
function requireBranchScope(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  const role = req.user.role;
  // Passing a fallback viewer here is the deliberate yes this route has to
  // give — the controller behind it does its own branch check, and its 403 is
  // what becomes the proposal. Claimed, so the write guard stands down.
  const pass = (why) => {
    if (req.viewerFallback) viewerContext.claim(`requireBranchScope:${why}`);
    return next();
  };
  if (role === 'system_admin' || role === 'accountant' || role === 'branch_manager' || role === ADMIN_VIEWER) return pass('role');
  if ((req.user.managed_branch_ids || []).length > 0) return pass('managed');
  return res.status(403).json({
    error: 'החשבון שלך אינו מוגדר כמנהל/ת סניף ולא משויכים אליו סניפים לניהול. '
      + 'אם ההרשאה ניתנה זה עתה — יש להתנתק ולהתחבר מחדש כדי לרענן אותה.',
    code: 'NO_BRANCH_SCOPE',
  });
}

module.exports = {
  authMiddleware, optionalAuth, requireRole, requireTab, requireTabWrite,
  requireBranchScope,
};
