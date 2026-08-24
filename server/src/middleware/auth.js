const jwt = require('jsonwebtoken');
const env = require('../config/env');

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

    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Optional auth - attaches user if token present, continues if not
 */
function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return next();
  }
  try {
    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, env.JWT_SECRET);
    if (sameTenant(req, decoded)) req.user = decoded;
  } catch {}
  next();
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
 * Usage: requireTab('clicktac', 'system_admin', 'accountant')
 */
function requireTab(tabId, ...defaultRoles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const u = req.user;
    const has = (list) => Array.isArray(list) && list.includes(tabId);

    if (has(u.tab_overrides_remove)) return res.status(403).json({ error: 'אין לך הרשאה לפעולה זו' });
    if (has(u.tab_overrides_add)) return next();
    if (has(u.role_tab_remove)) return res.status(403).json({ error: 'אין לך הרשאה לפעולה זו' });
    if (has(u.role_tab_add)) return next();
    if (defaultRoles.includes(u.role)) return next();
    return res.status(403).json({ error: 'אין לך הרשאה לפעולה זו' });
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
    next();
  });
}

/**
 * Role-based access control middleware factory
 * Usage: requireRole('system_admin', 'branch_manager')
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'אין לך הרשאה לפעולה זו' });
    }
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
  if (role === 'system_admin' || role === 'accountant' || role === 'branch_manager') return next();
  if ((req.user.managed_branch_ids || []).length > 0) return next();
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
