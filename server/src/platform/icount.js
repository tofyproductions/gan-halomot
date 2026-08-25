/**
 * Talking to iCount, where the money actually moves.
 *
 * WHAT LIVES THERE AND WHAT LIVES HERE. iCount holds the payment details and
 * issues the documents; we hold the price. The rules that decide what a
 * customer owes — the tiers, the monthly minimum, the free period — stay in
 * `billing.js` and in the tenant's own pricing, and iCount is handed a number
 * and a sentence explaining it. Two systems that both think they know the
 * price disagree the day one of them is edited, and the customer is the one
 * who finds out.
 *
 * THE PAYMENT DETAILS NEVER TOUCH US. A card is captured by iCount and comes
 * back as a token id; a bank account is typed into iCount's own screen. What
 * we store is an integer that means "the arrangement iCount has with this
 * customer". Losing our database must not be losing anybody's card.
 *
 * ONE RECURRING PROFILE PER CUSTOMER (iCount calls it הוראת קבע — `hk`). It
 * carries a single line, and once a month we rewrite that line to this month's
 * child count and amount. That is deliberate: a profile is a standing
 * arrangement the customer can see and cancel, and a customer who grew from
 * 180 children to 210 keeps the same arrangement at a new amount rather than
 * accumulating a new one every month.
 *
 * OFF UNLESS A TOKEN IS SET. Without ICOUNT_API_TOKEN nothing here reaches the
 * network, and every entry point says so rather than failing somewhere deeper.
 */

const BASE = process.env.ICOUNT_API_BASE || 'https://api.icount.co.il/api/v3.php';

/** Is the integration switched on at all? */
function enabled() {
  return Boolean(process.env.ICOUNT_API_TOKEN);
}

/**
 * One POST.
 *
 * `transport` exists so the tests can run the whole flow without a network and
 * without an account: everything above this line is the logic worth testing,
 * and iCount is not going to be reached from a laptop at midnight anyway.
 */
async function call(endpoint, payload = {}, { transport, timeoutMs = 20000 } = {}) {
  if (!enabled()) {
    throw Object.assign(new Error('אין חיבור ל-iCount — לא הוגדר ICOUNT_API_TOKEN'), { status: 503 });
  }

  const send = transport || defaultTransport;
  const body = await send({
    url: `${BASE}/${endpoint}`,
    token: process.env.ICOUNT_API_TOKEN,
    payload,
    timeoutMs,
  });

  // iCount answers 200 with status:false and a reason. Treating that as
  // success is how a failed charge is recorded as a paid month.
  if (body && body.status === false) {
    const why = body.error_description || body.reason || 'שגיאה לא ידועה';
    throw Object.assign(new Error(`iCount ${endpoint}: ${why}`), {
      status: 502,
      icount_reason: body.reason || null,
    });
  }
  return body;
}

async function defaultTransport({ url, token, payload, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch {
      throw new Error(`iCount החזיר תשובה שאינה JSON (${res.status}): ${text.slice(0, 120)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Open a standing arrangement for a customer.
 *
 * The client is identified by `custom_client_id` — our own slug — so iCount
 * finds or creates its own client record and the two systems stay joined by
 * something stable. Not by name: two gans called "גן הדקל" are two gans.
 */
function createProfile({
  slug, name, email, vat_id,
  items,
  hk_type,                 // 'cc' | 'bank'
  cc_token_id,
  bank_number, bank_branch, bank_account, deposit_to_bank,
  start_date, issue_every = 1, currency = 'ILS',
  email_to_client = true,
}, opts = {}) {
  if (!items || !items.length) throw new Error('אין שורות חיוב');
  if (hk_type === 'cc' && !cc_token_id) throw new Error('חיוב באשראי דורש cc_token_id מ-iCount');
  if (hk_type === 'bank' && !(bank_number && bank_branch && bank_account)) {
    throw new Error('הוראת קבע בנקאית דורשת בנק, סניף וחשבון');
  }

  const payload = {
    custom_client_id: slug,
    client_name: name,
    ...(email ? { email } : {}),
    ...(vat_id ? { vat_id } : {}),
    items,
    // 0 = unlimited. A subscription with a hidden end date is a subscription
    // that stops collecting one month without anybody deciding it should.
    num_of_payments: 0,
    issue_every,
    currency,
    email_to_client,
    ...(start_date ? { start_date } : {}),
    ...(hk_type === 'cc' ? { cc_token_id } : {}),
    ...(hk_type === 'bank' ? {
      bank_number, bank_branch, bank_account,
      ...(deposit_to_bank ? { deposit_to_bank } : {}),
    } : {}),
  };

  return call('hk/create', payload, opts);
}

/**
 * Rewrite the standing arrangement's line — this is the monthly act.
 * `items` is required by iCount on update, which suits us: the whole point of
 * the call is that the line changed.
 */
function updateProfileItems(hk_id, items, opts = {}) {
  if (!hk_id) throw new Error('אין hk_id');
  if (!items || !items.length) throw new Error('אין שורות חיוב');
  return call('hk/update', { hk_id, items }, opts);
}

/** What iCount thinks the arrangement is right now. */
function getProfile(hk_id, opts = {}) {
  if (!hk_id) throw new Error('אין hk_id');
  return call('hk/info', { hk_id }, opts);
}

/** Charge now rather than waiting for iCount's own cycle. Credit card only. */
function charge(hk_id, { force = false } = {}, opts = {}) {
  if (!hk_id) throw new Error('אין hk_id');
  return call('hk/charge', { hk_id, force }, opts);
}

/** Stop collecting. Used when a customer leaves — see suspendTenant. */
function cancelProfile(hk_id, opts = {}) {
  if (!hk_id) throw new Error('אין hk_id');
  return call('hk/cancel', { hk_id }, opts);
}

module.exports = {
  enabled, call,
  createProfile, updateProfileItems, getProfile, charge, cancelProfile,
};
