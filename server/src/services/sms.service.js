/**
 * Sending an SMS, behind one door.
 *
 * The parent portal needs a text message at exactly two moments: the first
 * time a parent activates their account, and every time one of them forgets
 * a password. That is a few hundred messages a year — small enough that the
 * provider is a commodity and large enough that being locked to one is silly.
 *
 * So every caller sees `sendSms({ to, text })` and nothing else. The provider
 * lives behind `SMS_PROVIDER`; swapping SMS4Free for anyone else is a new
 * function in this file and an env var, not a change anywhere upstream.
 *
 * Two decisions worth stating, because both are the opposite of the obvious:
 *
 * A missing configuration THROWS. It would be friendlier to log a warning and
 * return, but this is the code path that guards account activation — a silent
 * no-op means a parent waits forever for a code nobody sent, and the screen
 * says everything is fine. Loud is correct here.
 *
 * The message text is never logged. It carries the one-time code.
 */

const env = require('../config/env');

/**
 * SMS4Free's send endpoint, as documented in the account's own API panel:
 * a JSON POST of { key, user, pass, sender, recipient, msg }.
 *
 * `sender` must be a value the account has verified in the panel — an
 * unverified one comes back as -6 rather than as a delivery.
 */
const SMS4FREE_SEND_URL = 'https://api.sms4free.co.il/ApiSMS/v2/SendSMS';
const SMS4FREE_BALANCE_URL = 'https://api.sms4free.co.il/ApiSMS/AvailableSMS';

/**
 * An Israeli mobile number as the provider wants it: 0 followed by nine
 * digits.
 *
 * Parent phone numbers in this database were typed by whoever filled the
 * registration form, so they arrive as 050-1234567, 0501234567, +972501234567
 * and 972-50-1234567. All four are the same phone and all four must reach it.
 * Anything that does not resolve to an Israeli mobile is rejected here rather
 * than paid for and dropped by the carrier.
 */
function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;

  let local = digits;
  if (local.startsWith('972')) local = '0' + local.slice(3);
  if (!local.startsWith('0')) local = '0' + local;

  // Israeli mobile prefixes: 050-059. Landlines cannot receive an SMS.
  if (!/^05\d{8}$/.test(local)) return null;
  return local;
}

function isConfigured() {
  return Boolean(env.SMS_KEY && env.SMS_USER && env.SMS_PASS && env.SMS_SENDER);
}

/**
 * SMS4Free answers with a bare number, not a status object: a positive value
 * is how many messages it accepted, and anything else is a failure code. The
 * codes are documented in the account panel; they are surfaced verbatim so a
 * failure in the log names itself instead of arriving as "false".
 */
async function sendViaSms4Free({ to, text }) {
  const res = await fetch(SMS4FREE_SEND_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key: env.SMS_KEY,
      user: env.SMS_USER,
      pass: env.SMS_PASS,
      sender: env.SMS_SENDER,
      recipient: to,
      msg: text,
    }),
  });

  const body = (await res.text()).trim();

  if (!res.ok) {
    throw new Error(`SMS provider HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const code = Number(body);
  if (!Number.isFinite(code)) {
    throw new Error(`SMS provider returned unparseable response: ${body.slice(0, 200)}`);
  }
  if (code <= 0) {
    throw new Error(`SMS provider rejected the message (code ${code})`);
  }

  return { sent: code };
}

/**
 * Send one message.
 *
 * Resolves to { to, sent } on success and throws otherwise. Callers should let
 * the throw travel: every current caller is an interactive request where the
 * parent is waiting on the screen for the code.
 */
async function sendSms({ to, text }) {
  if (!isConfigured()) {
    throw new Error('SMS is not configured (SMS_KEY / SMS_USER / SMS_PASS / SMS_SENDER)');
  }
  if (!text || !String(text).trim()) {
    throw new Error('Refusing to send an empty SMS');
  }

  const recipient = normalizePhone(to);
  if (!recipient) {
    throw new Error(`Not an Israeli mobile number: ${String(to).slice(0, 20)}`);
  }

  const provider = (env.SMS_PROVIDER || 'sms4free').toLowerCase();
  if (provider !== 'sms4free') {
    throw new Error(`Unknown SMS_PROVIDER: ${provider}`);
  }

  const result = await sendViaSms4Free({ to: recipient, text });
  // Deliberately no message body in the log — it carries the one-time code.
  console.log(`[sms] sent to ${recipient} (${result.sent})`);
  return { to: recipient, sent: result.sent };
}

/**
 * Messages left in the bought package.
 *
 * Returns null when SMS is unconfigured or the provider will not answer, so a
 * dashboard can show "unknown" without the whole screen failing over a number
 * that is only ever informational.
 */
async function remainingBalance() {
  if (!isConfigured()) return null;
  try {
    const res = await fetch(SMS4FREE_BALANCE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: env.SMS_KEY, user: env.SMS_USER, pass: env.SMS_PASS }),
    });
    if (!res.ok) return null;
    const n = Number((await res.text()).trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

module.exports = { sendSms, remainingBalance, normalizePhone, isConfigured };
