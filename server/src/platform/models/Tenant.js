const mongoose = require('mongoose');

/**
 * A customer. One gan, or a network of twelve hundred.
 *
 * This is the ONLY collection in the system that knows other customers exist,
 * and it lives in a database of its own — the control plane — apart from every
 * customer's data. Nothing a gan's screens can query reaches this file.
 *
 * WHERE THE DATA LIVES IS A FIELD HERE, and that is the whole architecture.
 * A customer's children, employees and salaries sit in a database of their own
 * (`db_name`), on a cluster of their own choosing (`db_uri`). The application
 * is handed a connection and does not know whose it is, which is why 95,000
 * lines written for a single gan keep working unchanged — and why one customer
 * reading another's children is not a bug that can be written. There is no
 * query that spans two customers because there is no collection that holds
 * two customers.
 *
 * It also answers the question a network of 500 branches asks in the first ten
 * minutes: "is our data mixed in with everyone else's?" — no, and the answer
 * is structural rather than a promise about our code being careful.
 *
 * The cost is understood rather than discovered later: Atlas degrades past
 * roughly ten thousand collections on a cluster, and 77 collections per
 * customer puts that ceiling around 130 customers. `db_uri` is per-tenant
 * precisely so the 131st goes on a second cluster and nothing else changes.
 */
const tenantSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },

  /**
   * The subdomain: `shalhevet` serves shalhevet.dreamgan.com.
   *
   * Immutable once customers have been told their address, so it is not the
   * display name — a gan that rebrands changes `name` and keeps its logins.
   * Lowercase latin only, because it has to survive being read down a phone.
   */
  slug: {
    type: String, required: true, unique: true, lowercase: true, trim: true,
    match: [/^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/, 'slug must be 3-32 lowercase letters, digits or hyphens'],
  },

  status: {
    type: String,
    enum: ['pending', 'trial', 'active', 'suspended', 'closed'],
    default: 'pending',
    index: true,
  },

  // Where this customer's database lives. `db_uri` empty means "the default
  // cluster" — set it only when a customer is moved onto one of their own.
  db_uri: { type: String, default: '' },
  db_name: { type: String, required: true },

  /**
   * Money. Per-customer and not a lookup into a price list, because the price
   * list changes and a signed contract does not: a gan that agreed 50₪ in
   * August is still paying 50₪ after the list moves to 60₪.
   */
  pricing: {
    price_per_child: { type: Number, default: 50 },
    minimum_monthly: { type: Number, default: 400 },
    // Networks are quoted in bands. Empty means the flat rate above applies.
    // [{ up_to: 500, price: 50 }, { up_to: 3000, price: 25 }, { up_to: null, price: 12 }]
    tiers: { type: [{ up_to: Number, price: Number, _id: false }], default: [] },
    free_until: { type: Date, default: null },
    price_locked_until: { type: Date, default: null },
    currency: { type: String, default: 'ILS' },
  },

  /**
   * What they bought. Empty `packages` means everything — the launch sells one
   * price for the whole system, and the per-screen machinery is here so that
   * changing our minds is configuration rather than a release.
   */
  entitlements: {
    packages: { type: [String], default: [] },
    tabs_add: { type: [String], default: [] },
    tabs_remove: { type: [String], default: [] },
  },

  contact: {
    name: { type: String, default: '' },
    phone: { type: String, default: '' },
    email: { type: String, default: '' },
  },

  billing: {
    legal_name: { type: String, default: '' },
    tax_id: { type: String, default: '' },
    address: { type: String, default: '' },
    // Networks are invoiced and pay by transfer; a single gan is charged a card.
    method: { type: String, enum: ['card', 'invoice', ''], default: '' },
  },

  // The parent portal wears the gan's own name, not ours.
  branding: {
    display_name: { type: String, default: '' },
    logo_url: { type: String, default: '' },
    color: { type: String, default: '' },
  },

  trial_ends_at: { type: Date, default: null },
  activated_at: { type: Date, default: null },
  suspended_at: { type: Date, default: null },

  /**
   * Suspension does not delete. A gan that stops paying keeps its records for
   * six months — it is in the terms of use, it is what the law expects of
   * records about children, and it is what makes them come back.
   */
  purge_after: { type: Date, default: null },

  notes: { type: String, default: '' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

tenantSchema.index({ status: 1, created_at: -1 });

/** What a customer pays this month, given how many children they hold. */
tenantSchema.methods.monthlyCharge = function monthlyCharge(childCount) {
  const p = this.pricing || {};
  if (p.free_until && p.free_until > new Date()) return 0;

  let rate = p.price_per_child ?? 0;
  if (p.tiers && p.tiers.length) {
    // First band whose ceiling the customer fits under; a null ceiling is the last.
    const band = p.tiers.find((t) => t.up_to == null || childCount <= t.up_to);
    if (band) rate = band.price;
  }
  return Math.max(rate * childCount, p.minimum_monthly ?? 0);
};

module.exports = tenantSchema;
