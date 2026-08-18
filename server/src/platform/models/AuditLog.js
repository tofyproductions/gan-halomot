const mongoose = require('mongoose');

/**
 * Who did what to which customer.
 *
 * Support opening a customer's system is the feature that sells ("call us and
 * we'll look at it with you") and the one a network's security review asks
 * about first. An unlogged staff login into a gan's records is indefensible;
 * a logged one is a support call. It is also the only honest answer to "who
 * suspended us on the 3rd".
 */
const auditLogSchema = new mongoose.Schema({
  actor_id: { type: mongoose.Schema.Types.ObjectId, default: null },
  actor_email: { type: String, default: '' },
  action: { type: String, required: true, index: true },  // tenant.create | tenant.suspend | tenant.impersonate | ...
  tenant_id: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
  tenant_slug: { type: String, default: '' },
  detail: { type: mongoose.Schema.Types.Mixed, default: null },
  ip: { type: String, default: '' },
  at: { type: Date, default: Date.now, index: true },
}, { versionKey: false });

module.exports = auditLogSchema;
