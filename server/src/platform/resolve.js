const { isEnabled, controlPlane, tenantConnection } = require('./connection');

/**
 * Decide which customer this request belongs to, and hand the rest of the
 * application that customer's models.
 *
 * WHEN THE PLATFORM IS OFF this is a pass-through that attaches the ordinary
 * models on the ordinary connection. That is what lets the whole customer
 * layer be merged and deployed while גן החלומות is live: a server without
 * PLATFORM_MONGODB_URI behaves exactly as it always has.
 *
 * The host name is the only source of truth worth having. A header or a token
 * claim can be edited by whoever is holding it, and "which customer am I"
 * decided by the caller is every customer reading every other. The header
 * below exists for local development, where there are no subdomains, and it is
 * refused in production for that reason.
 */

/**
 * Names that are OURS, and can therefore never be a customer's slug.
 *
 * A reserved name is refused as a tenant rather than looked up, so the address
 * falls through to whatever else serves it. Without that, a subdomain we run
 * something else on is read as a customer nobody registered, and the whole
 * site answers 404 — which is a confusing afternoon, because the service
 * behind it is perfectly healthy and says so on its own port.
 *
 * `jobs` and `jobgan` are here for ג׳וב חלום, the public jobs board, which
 * runs as its own service and is reached at jobs.dreamgan.com until it gets a
 * domain of its own. Both spellings, because the address is a decision that
 * may still be typed either way and getting it wrong looks like a DNS fault.
 */
const RESERVED = new Set([
  'www', 'app', 'api', 'admin', 'console', 'status', 'mail', 'static', 'cdn',
  'jobs', 'jobgan',
]);

/**
 * ANCHORED ON OUR OWN DOMAIN, deliberately.
 *
 * The earlier version took the first label of any three-label host. That reads
 * `dreamgan.onrender.com` as a customer called "dreamgan" — the platform's own
 * Render address, which serves the console and the demo, would answer every
 * request with "לקוח לא נמצא" the day the customer registry is switched on.
 * The same trap waits behind any preview or staging host.
 *
 * So a customer is only named by a host that ends in the address we sell:
 * `<slug>.dreamgan.com`. Anything else names no customer, and the caller
 * decides whether that is an error.
 */
function slugFromHost(host) {
  if (!host) return null;
  const name = host.split(':')[0].toLowerCase().replace(/\.$/, '');
  if (name === 'localhost' || /^\d+(\.\d+)*$/.test(name)) return null;

  const domain = String(process.env.PLATFORM_DOMAIN || 'dreamgan.com').toLowerCase();
  if (!name.endsWith('.' + domain)) return null;    // our own Render host, a preview host, anything else

  const first = name.slice(0, -(domain.length + 1));
  if (!first || first.includes('.')) return null;   // dreamgan.com itself, or a deeper name
  if (RESERVED.has(first)) return null;
  return first;
}

function tenantResolver({ required = false } = {}) {
  return async function resolve(req, res, next) {
    if (!isEnabled()) {
      req.models = require('../models');
      req.tenant = null;
      return next();
    }

    try {
      let slug = slugFromHost(req.headers.host);

      if (!slug && process.env.NODE_ENV !== 'production') {
        slug = req.headers['x-tenant'] || null;
      }

      if (!slug) {
        if (required) return res.status(400).json({ error: 'לא זוהה לקוח בכתובת הזו' });
        req.models = require('../models');
        req.tenant = null;
        return next();
      }

      const { Tenant } = await controlPlane();
      const tenant = await Tenant.findOne({ slug });
      if (!tenant) return res.status(404).json({ error: 'לקוח לא נמצא' });

      // Suspended is not "gone". The data is still there and the customer is
      // told why, because the usual reason is an unpaid invoice and the usual
      // fix is a telephone call rather than a support ticket.
      if (tenant.status === 'suspended') {
        return res.status(402).json({ error: 'המנוי מושהה. צרו קשר להפעלה מחדש.', tenant: tenant.name });
      }
      if (tenant.status === 'closed') {
        return res.status(410).json({ error: 'המנוי נסגר.' });
      }
      if (tenant.status === 'pending') {
        return res.status(423).json({ error: 'המערכת בהקמה.' });
      }

      const { models } = await tenantConnection(tenant);
      req.tenant = tenant;
      req.models = models;
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { tenantResolver, slugFromHost, RESERVED };
