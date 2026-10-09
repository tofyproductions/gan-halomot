/**
 * The sensitive-area access log. Mounted in routes/index.js in front of the
 * routers that carry money and personal data; writes one row per request,
 * on response finish, fire-and-forget — the log must never slow or break
 * the request it describes. Board tablets are excluded (they poll all day
 * and can reach none of these areas anyway).
 */
function auditTrail(area) {
  return (req, res, next) => {
    res.on('finish', () => {
      try {
        if (!req.user?.id || req.user.role === 'classroom_board') return;
        // Required lazily: this middleware loads before the models index on boot.
        const { AuditTrail } = require('../models');
        AuditTrail.create({
          area,
          user_id: req.user.id,
          user_name: req.user.full_name || '',
          role: req.user.role,
          method: req.method,
          path: String(req.originalUrl || '').slice(0, 400),
          status: res.statusCode,
          ip: req.ip || '',
        }).catch(() => {});
      } catch { /* never break a request over its log */ }
    });
    next();
  };
}

module.exports = { auditTrail };
