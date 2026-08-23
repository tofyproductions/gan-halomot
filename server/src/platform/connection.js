const mongoose = require('mongoose');
const env = require('../config/env');

const tenantSchema = require('./models/Tenant');
const platformUserSchema = require('./models/PlatformUser');
const auditLogSchema = require('./models/AuditLog');
const orgUnitSchema = require('./models/OrgUnit');
const billingPeriodSchema = require('./models/BillingPeriod');

/**
 * Connections, and which database each request is talking to.
 *
 * OFF BY DEFAULT, and that is load-bearing rather than tidy. Without
 * PLATFORM_MONGODB_URI in the environment, `isEnabled()` is false, nothing
 * below ever runs, and the server behaves exactly as it did before this file
 * existed. גן החלומות is serving real families while this is being built; the
 * multi-customer machinery has to be unable to affect it, not merely unlikely
 * to.
 */

let control = null;
const tenants = new Map();       // slug -> { conn, models, lastUsed }

const IDLE_MS = 30 * 60 * 1000;  // a connection nobody has used for half an hour
const MAX_OPEN = 40;             // ceiling on simultaneously open customer databases

function isEnabled() {
  return Boolean(process.env.PLATFORM_MONGODB_URI);
}

/**
 * Swap the database name in a connection string.
 *
 * The query string is carried across untouched because it is where a
 * credential's authSource lives — dropping it authenticates against the wrong
 * database and fails in a way that reads like a bad password, an hour lost to
 * the wrong problem. Written out by hand rather than through URL(), whose
 * parser does not accept the mongodb+srv scheme's multi-host authority.
 */
function withDbName(uri, dbName) {
  const m = uri.match(/^(mongodb(?:\+srv)?:\/\/)([^/?]+)(?:\/([^?]*))?(\?.*)?$/);
  if (!m) throw new Error(`unrecognised mongodb uri: ${uri.slice(0, 24)}...`);
  const [, scheme, authority, , query = ''] = m;
  return `${scheme}${authority}/${dbName}${query}`;
}

/** The control plane: customers, us, and the audit log. Nothing else. */
async function controlPlane() {
  if (control) return control;
  if (!isEnabled()) throw new Error('PLATFORM_MONGODB_URI is not set');

  const conn = await mongoose.createConnection(process.env.PLATFORM_MONGODB_URI).asPromise();
  control = {
    conn,
    Tenant: conn.model('Tenant', tenantSchema),
    PlatformUser: conn.model('PlatformUser', platformUserSchema),
    AuditLog: conn.model('AuditLog', auditLogSchema),
    BillingPeriod: conn.model('BillingPeriod', billingPeriodSchema),
  };
  return control;
}

/**
 * Every model the application uses, compiled against one customer's connection.
 *
 * Mongoose exposes a compiled model's schema, so the 77 models keep their
 * single definition and are simply rebuilt per connection. The alternative —
 * threading a tenant id through every query in 58 controllers — is a change to
 * every line that reads data, and every line that got missed would be one
 * customer reading another's children.
 */
function bindModels(conn) {
  // The real models, not the per-request stand-ins — a stand-in has no schema
  // to offer until a customer is in scope, and here there is not one yet.
  const models = require('../models').__real || require('../models');
  const bound = { OrgUnit: conn.model('OrgUnit', orgUnitSchema) };
  for (const [name, Model] of Object.entries(models)) {
    if (!Model || !Model.schema) continue;
    bound[name] = conn.models[name] || conn.model(name, Model.schema);
  }
  return bound;
}

function evictIdle() {
  const now = Date.now();
  for (const [slug, entry] of tenants) {
    if (now - entry.lastUsed > IDLE_MS) {
      entry.conn.close().catch(() => {});
      tenants.delete(slug);
    }
  }
  // Still over the ceiling: drop the least recently used until we are not.
  while (tenants.size > MAX_OPEN) {
    const oldest = [...tenants.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
    oldest[1].conn.close().catch(() => {});
    tenants.delete(oldest[0]);
  }
}

/** Open (or reuse) a customer's database and hand back its models. */
async function tenantConnection(tenant) {
  const key = tenant.slug;
  const cached = tenants.get(key);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached;
  }

  const baseUri = tenant.db_uri || env.MONGODB_URI;
  if (!baseUri) throw new Error(`tenant ${key} has no database uri`);

  const conn = await mongoose.createConnection(withDbName(baseUri, tenant.db_name), {
    maxPoolSize: 5,           // 40 customers × 5 is already 200 sockets
    serverSelectionTimeoutMS: 8000,
  }).asPromise();

  const entry = { conn, models: bindModels(conn), lastUsed: Date.now() };
  tenants.set(key, entry);
  evictIdle();
  return entry;
}

async function closeAll() {
  for (const [, entry] of tenants) await entry.conn.close().catch(() => {});
  tenants.clear();
  if (control) { await control.conn.close().catch(() => {}); control = null; }
}

module.exports = { isEnabled, controlPlane, tenantConnection, bindModels, withDbName, closeAll,
  _openCount: () => tenants.size };
