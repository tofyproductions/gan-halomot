#!/usr/bin/env node
/**
 * gan iCount client — session reuse, relogin, throttle, error mapping.
 * Fake transport only; no network, no real credentials.
 *
 *   node scripts/gan-icount-client.test.js
 */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = { id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) } };

let failures = 0;
const ok = (c, l, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${l}${c || !d ? '' : `  (${d})`}`); if (!c) failures++; };
const eq = (a, b, l) => ok(a === b, l, `קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)}`);
const rejects = async (fn, code, l) => {
  try { await fn(); ok(false, `${l} — לא נזרקה שגיאה`); return null; } catch (e) {
    eq(e.code, code, `${l} → ${code}`); return e;
  }
};

const CREDS = { companyId: 'co-123', user: 'user-xyz', pass: 'pw-secret' };
const json = (o, httpStatus = 200) => ({ httpStatus, text: JSON.stringify(o) });

// Scripted fake: login answers by itself, other endpoints pop from `script`.
function fakeTransport(script = []) {
  const calls = [];
  let sids = 0;
  const t = async (req) => {
    calls.push({ url: req.url, form: Object.fromEntries(req.form) });
    if (req.url.endsWith('/auth/login')) return t.loginReply ? t.loginReply() : json({ status: true, sid: `sid${++sids}` });
    const next = script.shift();
    return typeof next === 'function' ? next(req) : next;
  };
  t.calls = calls;
  t.logins = () => calls.filter(c => c.url.endsWith('/auth/login')).length;
  return t;
}

async function suite() {
  const { createIcountClient } = require('../src/services/ganIcount.client');
  let clock = 1_000_000;
  const now = () => clock;
  const make = (transport, credentials = CREDS) => createIcountClient({ transport, now, credentials });

  console.log('unconfigured');
  {
    const t = fakeTransport();
    const c = make(t, {});
    eq(c.isConfigured(), false, 'isConfigured false');
    const st = c.status();
    eq(st.configured, false, 'status.configured false');
    eq(st.logged_in, false, 'status.logged_in false');
    const e = await rejects(() => c.post('/expense/search', {}), 'NOT_CONFIGURED', 'post');
    eq(e && e.message, 'לא מחובר', 'message "לא מחובר"');
    eq(t.calls.length, 0, 'no network call');
    const partial = make(fakeTransport(), { companyId: 'x', user: 'y' });
    eq(partial.isConfigured(), false, 'two of three is not configured');
  }

  console.log('login once, reused');
  {
    clock = 1_000_000;
    const t = fakeTransport([json({ status: true, results_list: [1] }), json({ status: true }), json({ status: true })]);
    const c = make(t);
    eq(c.isConfigured(), true, 'configured');
    const r = await c.post('/expense/search', { supplier_id: 7, limit: 500 });
    eq(r.results_list[0], 1, 'response returned as-is');
    await c.post('/expense/search', {});
    eq(t.logins(), 1, 'one login for two calls');
    const login = t.calls[0];
    eq(login.url, 'https://api.icount.co.il/api/v3.php/auth/login', 'login url');
    eq(login.form.cid, 'co-123', 'login cid');
    eq(login.form.user, 'user-xyz', 'login user');
    eq(login.form.pass, 'pw-secret', 'login pass');
    eq(t.calls[1].url, 'https://api.icount.co.il/api/v3.php/expense/search', 'call url');
    eq(Object.keys(t.calls[1].form)[0], 'sid', 'sid first');
    eq(t.calls[1].form.sid, 'sid1', 'sid value');
    eq(t.calls[1].form.supplier_id, '7', 'scalar stringified');
    eq(c.status().logged_in, true, 'logged_in true');
    eq(Object.values(c.status()).every(v => typeof v === 'boolean'), true, 'status booleans only');
    clock += 26 * 60 * 1000;
    eq(c.status().logged_in, false, 'session expires after 25 min');
    await c.post('/expense/search', {});
    eq(t.logins(), 2, 'relogin after 25 min');
  }

  console.log('nested params flattened, null skipped');
  {
    const t = fakeTransport([json({ status: true })]);
    const c = make(t);
    await c.post('/x', { a: [1, 2], o: { k: 'v' }, n: null, u: undefined });
    const f = t.calls[1].form;
    eq(f['a[0]'], '1', 'array[0]'); eq(f['a[1]'], '2', 'array[1]'); eq(f['o[k]'], 'v', 'object key');
    ok(!('n' in f) && !('u' in f), 'null/undefined skipped');
  }

  console.log('concurrent first calls share one login');
  {
    const t = fakeTransport([json({ status: true }), json({ status: true })]);
    const c = make(t);
    await Promise.all([c.post('/a', {}), c.post('/b', {})]);
    eq(t.logins(), 1, 'single login');
  }

  console.log('expired session → relogin + retry once');
  {
    clock = 2_000_000;
    const t = fakeTransport([json({ status: false, reason: 'Invalid sid' }), json({ status: true, ok: 1 })]);
    const c = make(t);
    const r = await c.post('/expense/search', {});
    eq(r.ok, 1, 'retry succeeded');
    eq(t.logins(), 2, 'logged in again');
    eq(t.calls[t.calls.length - 1].form.sid, 'sid2', 'retry used the new sid');
    // still expired after retry → ICOUNT_ERROR, no third attempt
    clock += 60_000;
    const t2 = fakeTransport([json({ status: false, reason: 'session expired' }), json({ status: false, reason: 'session expired' })]);
    const c2 = make(t2);
    const e = await rejects(() => c2.post('/x', {}), 'ICOUNT_ERROR', 'expired twice');
    eq(e && e.message, 'session expired', 'reason verbatim');
    eq(t2.calls.filter(x => !x.url.endsWith('/login')).length, 2, 'exactly one retry');
  }

  console.log('status:false → reason verbatim');
  {
    const t = fakeTransport([json({ status: false, reason: 'ספק לא קיים' }), json({ status: false, error_description: 'desc only' })]);
    const c = make(t);
    const e = await rejects(() => c.post('/expense/create', {}), 'ICOUNT_ERROR', 'status false');
    eq(e && e.message, 'ספק לא קיים', 'verbatim reason');
    const e2 = await rejects(() => c.post('/expense/create', {}), 'ICOUNT_ERROR', 'error_description fallback');
    eq(e2 && e2.message, 'desc only', 'fallback text');
  }

  console.log('throttle: plain text → THROTTLED, fail fast 90 s, then works');
  {
    clock = 3_000_000;
    const t = fakeTransport([{ httpStatus: 200, text: 'Too many requests' }, json({ status: true, fine: 1 })]);
    const c = make(t);
    const e = await rejects(() => c.post('/expense/search', {}), 'THROTTLED', 'plain text');
    eq(e && e.message, 'אייקאונט מגביל קצב — נסו שוב בעוד דקה', 'throttle message');
    eq(c.cooldownUntil(), clock + 90_000, 'cooldownUntil = now + 90 s');
    const before = t.calls.length;
    clock += 89_000;
    await rejects(() => c.post('/expense/search', {}), 'THROTTLED', 'inside cooldown');
    eq(t.calls.length, before, 'no network call during cooldown');
    clock += 1_001;
    const r = await c.post('/expense/search', {});
    eq(r.fine, 1, 'works after cooldown');
  }

  console.log('throttle: HTTP 429 and during login');
  {
    clock = 4_000_000;
    const c = make(fakeTransport([{ httpStatus: 429, text: '<html>slow</html>' }]));
    await rejects(() => c.post('/x', {}), 'THROTTLED', '429 with html body');
    clock = 5_000_000;
    const t = fakeTransport();
    t.loginReply = () => ({ httpStatus: 200, text: 'Too many requests' });
    const c2 = make(t);
    await rejects(() => c2.post('/x', {}), 'THROTTLED', 'throttled at login');
    eq(c2.cooldownUntil(), clock + 90_000, 'login throttle sets cooldown');
  }

  console.log('non-JSON that is not a throttle');
  {
    clock = 6_000_000;
    const c = make(fakeTransport([{ httpStatus: 502, text: '<html>  Bad   Gateway </html>' }]));
    const e = await rejects(() => c.post('/x', {}), 'ICOUNT_ERROR', '502 page');
    ok(e && /502/.test(e.message), 'status in message', e && e.message);
    eq(c.cooldownUntil(), 0, 'no cooldown for a 502');
  }

  console.log('login failure → ICOUNT_ERROR, 10 s backoff, credentials never leak');
  {
    clock = 7_000_000;
    const t = fakeTransport();
    t.loginReply = () => json({ status: false, reason: 'bad credentials' });
    const c = make(t);
    const e = await rejects(() => c.post('/x', {}), 'ICOUNT_ERROR', 'login failed');
    ok(e && !/pw-secret|user-xyz|co-123/.test(e.message), 'no credential in message', e && e.message);
    const n = t.calls.length;
    await rejects(() => c.post('/x', {}), 'ICOUNT_ERROR', 'backoff');
    eq(t.calls.length, n, 'no login attempt inside 10 s');
    clock += 10_001;
    t.loginReply = null;
    const r = await c.post('/x', {}).catch(x => x);
    ok(t.logins() >= 2, 'after backoff a new login is attempted');
    void r;
  }

  console.log('nothing logs');
  {
    const seen = [];
    const orig = [console.log, console.error, console.warn];
    console.log = console.error = console.warn = (...a) => seen.push(a.join(' '));
    try {
      const t = fakeTransport();
      t.loginReply = () => json({ status: false, reason: 'nope' });
      await make(t).post('/x', {}).catch(() => {});
    } finally { [console.log, console.error, console.warn] = orig; }
    ok(!seen.some(s => /pw-secret|user-xyz|co-123/.test(s)), 'no credential logged');
  }

  console.log('getClient singleton');
  {
    const m = require('../src/services/ganIcount.client');
    eq(m.getClient(), m.getClient(), 'same instance');
    eq(typeof m.getClient().isConfigured(), 'boolean', 'works without env');
  }
}

suite().then(() => {
  console.log(failures ? `\n❌ ${failures} נכשלו` : '\n✅ הכול עבר');
  process.exit(failures ? 1 : 0);
}).catch(e => { console.error(e); process.exit(1); });
