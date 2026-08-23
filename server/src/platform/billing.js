const { controlPlane, tenantConnection } = require('./connection');

/**
 * Work out what every customer owes for a month, and write it down.
 *
 * The charge itself is `tenant.monthlyCharge(children)` and is not
 * reimplemented here — a second copy of the pricing rules, kept in step with
 * the first by hand, is the month somebody edits only one of them and a
 * customer is billed a number the system cannot explain.
 *
 * What this adds is the freezing and the explaining.
 *
 * FREEZING: the child count is read once, on the day the run happens, and
 * stored. Reading it live is right for a screen and wrong for an invoice —
 * March's bill must not change in May because two children joined.
 *
 * EXPLAINING: "why is this ₪400 when we have three children" is the first
 * question a customer asks. The answer is written onto the row in words at the
 * moment the number is produced, while the reason is still known, rather than
 * reconstructed later from whatever the code does by then.
 *
 * A month already computed is left alone unless `recompute` is asked for. A run
 * that silently overwrote yesterday's figures would be the same problem as
 * computing them live, one step further from anybody noticing.
 */

/** Say, in Hebrew, how this number came about. */
function explain({ tenant, children, rate, amount }) {
  const p = tenant.pricing || {};
  if (p.free_until && new Date(p.free_until) > new Date()) {
    return `חודש חינם עד ${new Date(p.free_until).toLocaleDateString('he-IL')}`;
  }
  const parts = [];
  const tier = (p.tiers || []).find((t) => t.up_to == null || children <= t.up_to);
  if (tier) {
    parts.push(tier.up_to == null
      ? `מדרגה עליונה: ₪${tier.price} לילד`
      : `מדרגה עד ${tier.up_to} ילדים: ₪${tier.price} לילד`);
  } else {
    parts.push(`₪${rate} לילד`);
  }
  parts.push(`${children} ילדים = ₪${(rate * children).toLocaleString('he-IL')}`);
  if (amount > rate * children) {
    parts.push(`מתחת למינימום החודשי — חויב ₪${(p.minimum_monthly ?? 0).toLocaleString('he-IL')}`);
  }
  return parts.join(' · ');
}

/**
 * @param {object} opts
 * @param {string} opts.month           'YYYY-MM'
 * @param {boolean} [opts.recompute]    overwrite a month already computed
 * @param {boolean} [opts.dryRun]       work it out and write nothing
 */
async function runMonth({ month, recompute = false, dryRun = false } = {}) {
  if (!month || !/^\d{4}-\d{2}$/.test(month)) throw new Error('month=YYYY-MM נדרש');

  const { Tenant, BillingPeriod } = await controlPlane();

  // Suspended and closed customers are not billed. A customer who has been
  // switched off and still gets an invoice is the switch not working, and it is
  // the kind of mistake that ends a relationship rather than a month.
  const tenants = await Tenant.find({ status: { $in: ['active', 'trial'] } }).lean();

  const rows = [];
  const failed = [];

  for (const t of tenants) {
    try {
      const existing = await BillingPeriod.findOne({ month, tenant_id: t._id }).lean();
      if (existing && !recompute) {
        rows.push({ ...existing, skipped: true });
        continue;
      }
      // Issued or paid months are never silently rewritten, even with
      // --recompute. Changing a number the customer has already been given is a
      // conversation, not a command-line flag.
      if (existing && ['issued', 'paid'].includes(existing.status)) {
        rows.push({ ...existing, skipped: true, locked: true });
        continue;
      }

      const { models } = await tenantConnection(t);
      const children = await models.Child.countDocuments({ is_active: { $ne: false } });

      // Rebuild a document so the schema method is available, rather than
      // copying the pricing rules into this file.
      const doc = new Tenant(t);
      const amount = doc.monthlyCharge(children);

      const p = t.pricing || {};
      let rate = p.price_per_child ?? 0;
      const tier = (p.tiers || []).find((x) => x.up_to == null || children <= x.up_to);
      if (tier) rate = tier.price;

      const row = {
        tenant_id: t._id,
        tenant_slug: t.slug,
        tenant_name: t.name,
        month,
        children,
        rate,
        amount,
        currency: p.currency || 'ILS',
        breakdown: explain({ tenant: t, children, rate, amount }),
        status: 'draft',
        computed_at: new Date(),
      };

      if (!dryRun) {
        await BillingPeriod.updateOne({ month, tenant_id: t._id }, { $set: row }, { upsert: true });
      }
      rows.push(row);
    } catch (err) {
      // A customer whose database cannot be reached is REPORTED, never billed
      // at zero. A silent zero is an invoice that quietly forgets to charge.
      failed.push({ slug: t.slug, error: err.message });
    }
  }

  const total = rows.reduce((a, r) => a + (r.amount || 0), 0);
  return { month, tenants: tenants.length, rows, failed, total, dryRun };
}

module.exports = { runMonth, explain };
