const { isEnabled, controlPlane } = require('../platform/connection');

/**
 * What a customer is allowed to know about their own subscription.
 *
 * WHY THIS SCREEN EXISTS. Everything about what a gan pays lived in our
 * console, which they cannot open. So "how much am I paying this month", "how
 * many children did you count", "when does my trial end" and "which card is
 * on file" were all telephone calls to us. With five customers that is a
 * conversation; with twenty it is somebody's job.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It reads. A customer cannot change their
 * own price, and nothing here writes — the pricing is what was agreed, and an
 * agreement is not a form. Changing a payment method is a link to iCount,
 * whose page is where card details belong.
 *
 * SCOPE. Everything comes from `req.tenant`, which the resolver set from the
 * host name. There is no id in the request to tamper with, so a customer
 * cannot ask about another one — the question cannot be phrased.
 */

/** Fields a customer may see. Anything not listed is ours, not theirs. */
function publicPlan(tenant) {
  const p = tenant.pricing || {};
  return {
    price_per_child: p.price_per_child ?? 0,
    minimum_monthly: p.minimum_monthly ?? 0,
    tiers: (p.tiers || []).map((t) => ({ up_to: t.up_to ?? null, price: t.price })),
    free_until: p.free_until || null,
    currency: p.currency || 'ILS',
  };
}

exports.myAccount = async (req, res, next) => {
  try {
    // On a single-gan server there is no subscription to describe, and saying
    // that plainly beats an empty screen that looks broken.
    if (!isEnabled() || !req.tenant) {
      return res.status(404).json({ error: 'המסך הזה קיים רק כשהמערכת מסופקת כשירות' });
    }

    const { Tenant, BillingPeriod } = await controlPlane();
    const tenant = await Tenant.findById(req.tenant._id);
    if (!tenant) return res.status(404).json({ error: 'לא נמצא מנוי' });

    const month = new Date().toISOString().slice(0, 7);

    // The same computation the billing run uses, so the number here and the
    // number on the invoice cannot drift apart.
    let current = null;
    let currentError = null;
    try {
      const sub = require('../platform/subscription');
      const { children, amount, breakdown, rate } = await sub.preview(tenant, { month });
      current = { month, children, amount, rate, breakdown };
    } catch (e) {
      currentError = e.message;
    }

    // Their own months only, newest first. `breakdown` is included on purpose:
    // it is the sentence that answers "why is this ₪400 for three children",
    // and it was written when the number was produced.
    const history = await BillingPeriod.find({ tenant_id: tenant._id })
      .sort({ month: -1 }).limit(24)
      .select('month children rate amount currency breakdown status issued_at paid_at')
      .lean();

    const link = tenant.billing?.icount || {};

    res.json({
      name: tenant.name,
      address: `${tenant.slug}.${process.env.PLATFORM_DOMAIN || 'dreamgan.com'}`,
      status: tenant.status,
      trial_ends_at: tenant.trial_ends_at || null,
      since: tenant.activated_at || tenant.created_at || null,
      plan: publicPlan(tenant),
      current,
      current_error: currentError,
      payment: {
        // Which arrangement, never the details of it — we do not hold those.
        method: link.hk_type || '',
        connected: Boolean(link.hk_id),
      },
      history,
      support: {
        email: process.env.SUPPORT_EMAIL || 'halom.dreamgan@gmail.com',
        phone: process.env.SUPPORT_PHONE || '',
      },
    });
  } catch (err) { next(err); }
};
