const { controlPlane, tenantConnection } = require('./connection');
const { explain } = require('./billing');
const icount = require('./icount');

/**
 * Keeping a customer's standing charge equal to what they actually owe.
 *
 * THE SHAPE. Each customer has one recurring profile at iCount carrying one
 * line. Once a month we count their children, work out the amount with the
 * same rules the billing screen uses, and rewrite that line. iCount then
 * charges and issues the document.
 *
 * WHEN THE CHILDREN ARE COUNTED. On the day the sync runs, and that is a
 * decision rather than an implementation detail: a child who left on the 3rd
 * does not change the month that was billed on the 1st. It is the version a
 * customer can check for themselves — "on the 1st you had 212 children" — and
 * the one nobody can argue with a week later.
 *
 * WHAT THE LINE SAYS. When the plain price applies, the line is quantity ×
 * price, because that is what the customer expects to see on the invoice. When
 * the monthly minimum bites, quantity × price would not add up to the amount,
 * so the line becomes a single item whose description says exactly why. An
 * invoice whose numbers do not multiply out is an invoice that generates a
 * phone call.
 *
 * NOTHING HERE INVENTS A PRICE. The amount comes from tenant.monthlyCharge,
 * the same method the console and the billing run use.
 */

/** What this month's line would be, without touching iCount. */
async function preview(tenantDoc, { month } = {}) {
  const { models } = await tenantConnection(tenantDoc);
  const children = await models.Child.countDocuments({ is_active: { $ne: false } });

  const amount = tenantDoc.monthlyCharge(children);
  const p = tenantDoc.pricing || {};
  let rate = p.price_per_child ?? 0;
  const tier = (p.tiers || []).find((t) => t.up_to == null || children <= t.up_to);
  if (tier) rate = tier.price;

  const label = month
    ? new Date(`${month}-01`).toLocaleDateString('he-IL', { month: 'long', year: 'numeric' })
    : '';
  const breakdown = explain({ tenant: tenantDoc, children, rate, amount });

  // Does quantity × price actually reach the amount? If not, one line that
  // explains itself beats two numbers that do not multiply out.
  const multipliesOut = Math.abs(rate * children - amount) < 0.005 && children > 0;

  const items = multipliesOut
    ? [{
      description: `מנוי חלום${label ? ` — ${label}` : ''} · ${children} ילדים`,
      unitprice: rate,
      quantity: children,
    }]
    : [{
      description: `מנוי חלום${label ? ` — ${label}` : ''} · ${children} ילדים · ${breakdown}`,
      unitprice: amount,
      quantity: 1,
    }];

  return { children, rate, amount, breakdown, items, month: month || null };
}

/**
 * Open the standing arrangement. Done once, when a customer starts paying.
 *
 * The payment details are not ours to hold: for a card, iCount captures it and
 * hands back a token id; for a bank standing order, the account details are
 * typed here only to be passed straight through and are never stored on our
 * side. What we keep is the profile id.
 */
async function openProfile(tenantId, payment, opts = {}) {
  const { Tenant, AuditLog } = await controlPlane();
  const tenant = await Tenant.findById(tenantId);
  if (!tenant) throw Object.assign(new Error('לקוח לא נמצא'), { status: 404 });
  if (tenant.billing?.icount?.hk_id) {
    throw Object.assign(new Error('ללקוח כבר יש הוראת קבע פעילה ב-iCount'), { status: 409 });
  }

  const month = new Date().toISOString().slice(0, 7);
  const { items, children, amount } = await preview(tenant, { month });

  const res = await icount.createProfile({
    slug: tenant.slug,
    name: tenant.billing?.legal_name || tenant.name,
    email: tenant.contact?.email || '',
    vat_id: tenant.billing?.tax_id || '',
    items,
    hk_type: payment.hk_type,
    cc_token_id: payment.cc_token_id,
    bank_number: payment.bank_number,
    bank_branch: payment.bank_branch,
    bank_account: payment.bank_account,
    deposit_to_bank: payment.deposit_to_bank,
    start_date: payment.start_date,
    currency: tenant.pricing?.currency || 'ILS',
  }, opts);

  const hkId = res.hk_id || res.id;
  if (!hkId) throw new Error('iCount לא החזיר מזהה הוראת קבע');

  tenant.billing = tenant.billing || {};
  tenant.billing.icount = {
    hk_id: hkId,
    hk_type: payment.hk_type,
    client_id: res.client_id || null,
    opened_at: new Date(),
    last_sync: { month, children, amount, at: new Date(), ok: true, error: '' },
  };
  // Keep the human-readable field the console already shows in step with it.
  tenant.billing.method = payment.hk_type === 'cc' ? 'card' : 'invoice';
  await tenant.save();

  await AuditLog.create({
    actor_id: opts.actor?._id || null, actor_email: opts.actor?.email || '',
    action: 'tenant.subscription_open', tenant_id: tenant._id, tenant_slug: tenant.slug,
    detail: { hk_id: hkId, hk_type: payment.hk_type, children, amount },
  });

  return { hk_id: hkId, children, amount, items };
}

/**
 * Bring one customer's standing line up to date.
 *
 * `dryRun` returns exactly what would be sent and sends nothing. It is the
 * default everywhere it can be, because the first question before a run that
 * changes what people are charged is "what is it about to charge them".
 */
async function syncOne(tenantId, { month, dryRun = true, actor } = {}, opts = {}) {
  const { Tenant, AuditLog } = await controlPlane();
  const tenant = await Tenant.findById(tenantId);
  if (!tenant) throw Object.assign(new Error('לקוח לא נמצא'), { status: 404 });

  const hkId = tenant.billing?.icount?.hk_id;
  if (!hkId) throw Object.assign(new Error('ללקוח אין הוראת קבע ב-iCount'), { status: 400 });

  const m = month || new Date().toISOString().slice(0, 7);
  const { items, children, amount, breakdown } = await preview(tenant, { month: m });

  if (dryRun) return { dryRun: true, hk_id: hkId, month: m, children, amount, breakdown, items };

  let ok = true;
  let error = '';
  try {
    await icount.updateProfileItems(hkId, items, opts);
  } catch (err) {
    ok = false;
    error = err.message;
  }

  // Recorded either way. A sync that failed and left no trace is a customer
  // charged last month's amount with nobody aware of it.
  tenant.billing.icount.last_sync = { month: m, children, amount, at: new Date(), ok, error };
  await tenant.save();

  await AuditLog.create({
    actor_id: actor?._id || null, actor_email: actor?.email || '',
    action: 'tenant.subscription_sync', tenant_id: tenant._id, tenant_slug: tenant.slug,
    detail: { hk_id: hkId, month: m, children, amount, ok, error },
  });

  if (!ok) throw Object.assign(new Error(error), { status: 502 });
  return { hk_id: hkId, month: m, children, amount, breakdown, items };
}

/**
 * Every paying customer, one at a time.
 *
 * Serial on purpose. This is a small number of calls to somebody else's API
 * on a day when money moves; forty at once is how a rate limit turns into a
 * month where half the customers were charged the old amount.
 *
 * A customer that fails does not stop the rest, and the failures are returned
 * rather than logged and forgotten — a partial billing month is exactly the
 * thing somebody has to see.
 */
async function syncAll({ month, dryRun = true, actor } = {}, opts = {}) {
  const { Tenant } = await controlPlane();
  const tenants = await Tenant.find({
    status: { $in: ['active', 'trial'] },
    'billing.icount.hk_id': { $exists: true, $ne: null },
  }).select('_id slug name').lean();

  const done = [];
  const failed = [];
  for (const t of tenants) {
    try {
      done.push({ slug: t.slug, ...(await syncOne(t._id, { month, dryRun, actor }, opts)) });
    } catch (err) {
      failed.push({ slug: t.slug, error: err.message });
    }
  }
  return { month: month || new Date().toISOString().slice(0, 7), dryRun, done, failed };
}

module.exports = { preview, openProfile, syncOne, syncAll };
