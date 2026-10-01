/**
 * iCount session client for the expenses ledger.
 *
 * Ported from tofy-friends (see docs/superpowers/specs/2026-10-01-icount-port-notes.md
 * §1-§3). Three things here were each a real incident there:
 *
 *  - iCount invalidates every session but the last, so two logins racing each
 *    other kill each other. Logins are coalesced into one in-flight promise.
 *  - iCount throttles by answering PLAIN TEXT ("Too many requests"), not JSON.
 *    Retrying through a throttle turns a short one into a long one, so the first
 *    refusal closes the door for 90 s for everything that uses this client.
 *  - A 200 with status:false is a refusal, not a success. It is thrown, with
 *    iCount's own reason verbatim, so nobody records a failed write as filed.
 *
 * OFF UNLESS CONFIGURED. Without GAN_ICOUNT_COMPANY_ID / _USER / _PASS nothing
 * reaches the network. Credentials are never logged, never put in an error
 * message and never returned; status() answers with booleans only.
 *
 * `transport({ url, form, timeoutMs })` → `{ httpStatus, text }` is injectable
 * so tests run the whole flow with no network.
 */

const BASE = 'https://api.icount.co.il/api/v3.php';
const SESSION_TTL_MS = 25 * 60 * 1000;
const LOGIN_BACKOFF_MS = 10_000;
const THROTTLE_COOLDOWN_MS = 90_000;
const FORCED_RELOGIN_GUARD_MS = 20_000;
const LOGIN_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 30_000;

const THROTTLE_RE = /too many requests|rate limit|slow down|429/i;
// iCount words an expired session many ways; this is the set that was seen.
const AUTH_RE = /\bsid\b|session|logged|login required|unauthor|expired|invalid token/i;

const THROTTLE_MESSAGE = 'אייקאונט מגביל קצב — נסו שוב בעוד דקה';

const fail = (message, code, extra = {}) => Object.assign(new Error(message), { code, ...extra });

async function defaultFetchTransport({ url, form, timeoutMs }) {
  const res = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  return { httpStatus: res.status, text: await res.text() };
}

/** Bracket-flatten nested values the way iCount's form API expects. */
function appendParams(form, key, value) {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) value.forEach((v, i) => appendParams(form, `${key}[${i}]`, v));
  else if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) appendParams(form, `${key}[${k}]`, v);
  } else form.append(key, String(value));
}

const reasonOf = (data) => String(data?.reason ?? data?.error_description ?? data?.error ?? 'שגיאה לא ידועה');

function createIcountClient({ transport = defaultFetchTransport, now = Date.now, credentials } = {}) {
  let sid = null;
  let sidExpiry = 0;
  let loginInFlight = null;
  let loginCooldownUntil = 0;
  let throttledUntil = 0;
  let lastForcedReset = -Infinity;

  // Read at call time so a changed environment is honoured without a restart,
  // and so tests can hand credentials in directly.
  const creds = () => {
    if (credentials) return credentials;
    const env = require('../config/env');
    return { companyId: env.GAN_ICOUNT_COMPANY_ID, user: env.GAN_ICOUNT_USER, pass: env.GAN_ICOUNT_PASS };
  };
  const isConfigured = () => {
    const c = creds();
    return Boolean(c.companyId && c.user && c.pass);
  };

  const sessionLive = () => Boolean(sid) && now() < sidExpiry;
  const resetSession = () => { sid = null; sidExpiry = 0; };
  const startThrottle = () => { throttledUntil = now() + THROTTLE_COOLDOWN_MS; };
  const throttleError = () => fail(THROTTLE_MESSAGE, 'THROTTLED');

  /** Send one form; return parsed JSON. Plain text is a throttle or an error, never a crash. */
  async function send(endpoint, form, timeoutMs) {
    const { httpStatus, text } = await transport({ url: `${BASE}${endpoint}`, form, timeoutMs });
    try { return JSON.parse(text); } catch {
      if (httpStatus === 429 || THROTTLE_RE.test(text || '')) {
        startThrottle();
        throw throttleError();
      }
      // A 502 page is a different problem from a throttle; say which.
      const snippet = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      throw fail(`תשובה לא תקינה מאייקאונט (${httpStatus}): ${snippet}`, 'ICOUNT_ERROR');
    }
  }

  function getSession() {
    if (sessionLive()) return Promise.resolve(sid);
    if (loginInFlight) return loginInFlight;
    if (now() < loginCooldownUntil) {
      return Promise.reject(fail('התחברות לאייקאונט נכשלה לאחרונה — נסו שוב בעוד רגע', 'ICOUNT_ERROR'));
    }
    const { companyId, user, pass } = creds();
    const form = new URLSearchParams({ cid: companyId, user, pass });
    loginInFlight = (async () => {
      let data;
      try {
        data = await send('/auth/login', form, LOGIN_TIMEOUT_MS);
      } catch (e) {
        if (e.code !== 'THROTTLED') loginCooldownUntil = now() + LOGIN_BACKOFF_MS;
        throw e;
      }
      if (!data || !data.status || !data.sid) {
        loginCooldownUntil = now() + LOGIN_BACKOFF_MS;
        // Reason only — never the form we sent.
        throw fail(`התחברות לאייקאונט נכשלה: ${reasonOf(data)}`, 'ICOUNT_ERROR');
      }
      sid = String(data.sid);
      sidExpiry = now() + SESSION_TTL_MS;
      return sid;
    })();
    const p = loginInFlight;
    const clear = () => { if (loginInFlight === p) loginInFlight = null; };
    p.then(clear, clear);
    return p;
  }

  async function post(method, params = {}, retryOnAuth = true) {
    if (!isConfigured()) throw fail('לא מחובר', 'NOT_CONFIGURED');
    if (now() < throttledUntil) throw throttleError();

    const session = await getSession();
    const form = new URLSearchParams();
    form.append('sid', session);
    for (const [k, v] of Object.entries(params || {})) appendParams(form, k, v);

    const data = await send(method, form, CALL_TIMEOUT_MS);

    if (data && data.status === false) {
      const reason = reasonOf(data);
      if (retryOnAuth && AUTH_RE.test(reason) && now() - lastForcedReset > FORCED_RELOGIN_GUARD_MS) {
        // Global guard: a login storm is worse than one failed call.
        lastForcedReset = now();
        resetSession();
        return post(method, params, false);
      }
      throw fail(reason, 'ICOUNT_ERROR');
    }
    return data;
  }

  return {
    isConfigured,
    status: () => ({ configured: isConfigured(), logged_in: sessionLive() }),
    post,
    cooldownUntil: () => throttledUntil,
  };
}

let singleton = null;
function getClient() {
  if (!singleton) singleton = createIcountClient();
  return singleton;
}

/**
 * Test hook: put a client built with a fake transport in place of the
 * singleton (null restores the real one). Refuses to run in production, and
 * nothing outside tests calls it.
 */
function __setClientForTests(client) {
  if (process.env.NODE_ENV === 'production') throw new Error('__setClientForTests is not available in production');
  singleton = client || null;
}

module.exports = { createIcountClient, getClient, __setClientForTests, defaultFetchTransport, BASE, THROTTLE_MESSAGE };
