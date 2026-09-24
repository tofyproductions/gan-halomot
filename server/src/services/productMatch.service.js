/**
 * The same product at the other supplier.
 *
 * See docs/superpowers/specs/2026-09-24-product-price-comparison-design.md.
 * This file owns: the fingerprint that says "already looked at", the call to
 * Claude (client injectable so tests never touch the network), the throttle,
 * the admin's decisions, and the per-unit comparison the order form shows.
 */
const crypto = require('crypto');

/** supplier + sku + name + unit. Not the price: a price change is not a new product. */
function fingerprintOf(p) {
  const s = [p.supplier_id, p.sku || '', p.name || '', p.unit || ''].map(String).join('|');
  return crypto.createHash('sha256').update(s).digest('hex');
}

module.exports = { fingerprintOf };
