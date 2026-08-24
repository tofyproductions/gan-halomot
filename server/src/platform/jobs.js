/**
 * Running the scheduled work on a server that serves many customers.
 *
 * THE PROBLEM. Every job here is written the way the rest of the application
 * is written — `const { Employee } = require('../models')`, resolved once at
 * import. On a single-gan server that is the gan. On a control plane those are
 * the per-request stand-ins from `platform/context`, and a job is not a
 * request: there is no customer in scope, so the first query throws.
 *
 * That throw is the good outcome and it is deliberate (see models/index.js).
 * The bad outcome would have been a fallback to the default connection, where
 * an hourly job quietly writes one customer's payroll into an empty database,
 * or worse, into another customer's.
 *
 * So the job runs once per customer, each inside that customer's models, and
 * the loop is SERIAL. Forty customers × a Chromium launch, or forty × a full
 * month's punches, arriving together is how a 512MB instance dies at 03:00
 * with nobody watching. Slow and finishing beats fast and restarting.
 *
 * One customer failing does not stop the rest — a network with a broken
 * mailbox must not cost every other network its nightly work.
 *
 * NOT EVERY JOB BELONGS HERE. The mail, Google Sheets and AI jobs authenticate
 * with credentials that live in the server's own environment — one mailbox,
 * one spreadsheet, one API key. Run per customer they would read OUR mailbox
 * on behalf of somebody else's gan and file the results in their database.
 * They stay off until a customer can carry its own credentials, and the boot
 * log says so rather than leaving it to be discovered.
 */

const { isEnabled, controlPlane, tenantConnection } = require('./connection');
const { runWith } = require('./context');

/**
 * Run `fn(models, tenant)` once for every customer that is switched on.
 * Returns a small report so a caller can log one line instead of forty.
 */
async function forEachTenant(label, fn) {
  if (!isEnabled()) throw new Error('forEachTenant על שרת שאינו פלטפורמה');

  const { Tenant } = await controlPlane();
  // Suspended and closed customers are not merely unbilled — their data must
  // stop moving. A nightly job that keeps working for a customer who has been
  // switched off is the switch not working.
  const tenants = await Tenant.find({ status: { $in: ['active', 'trial'] } })
    .select('_id name slug db_uri db_name').lean();

  const failed = [];
  let ok = 0;

  for (const tenant of tenants) {
    try {
      const { models } = await tenantConnection(tenant);
      await runWith(models, () => fn(models, tenant));
      ok += 1;
    } catch (err) {
      failed.push({ slug: tenant.slug, error: err.message });
    }
  }

  if (failed.length) {
    console.error(`[${label}] נכשל אצל ${failed.length} לקוחות: ` +
      failed.map((f) => `${f.slug} (${f.error})`).join(', '));
  }
  console.log(`[${label}] רץ אצל ${ok}/${tenants.length} לקוחות`);
  return { ok, failed };
}

/**
 * Wrap a job written for one gan so it can be scheduled on a control plane.
 * The returned function takes no arguments, so it drops into setInterval
 * exactly where the original did.
 */
function perTenant(label, job) {
  return () => forEachTenant(label, () => job())
    .catch((e) => console.error(`[${label}] העבודה נפלה כולה:`, e.message));
}

module.exports = { forEachTenant, perTenant };
