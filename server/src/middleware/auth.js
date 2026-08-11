const jwt = require('jsonwebtoken');
const env = require('../config/env');

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, env.JWT_SECRET);
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
    req.user = jwt.verify(token, env.JWT_SECRET);
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
  authMiddleware, optionalAuth, requireRole, requireTab, requireBranchScope,
};
