/**
 * ג׳וב חלום's own sender. Self-contained, on purpose.
 *
 * ⚠️ THIS FILE EXISTS BECAUSE ONE `require` UNDID THE WHOLE SEPARATION.
 *
 * The first version reused services/email.service.js — sensible on its face:
 * it already knows the three providers, and a second implementation is a
 * second thing to keep working. But that module loads config/env.js, and the
 * security work made config/env.js REFUSE TO LOAD in production without the
 * gan's JWT_SECRET. This service has no JWT_SECRET; it signs with
 * JOBGAN_JWT_SECRET, deliberately, so that a jobseeker's token is not
 * something the gan's server would ever accept.
 *
 * So the public jobs board crashed on boot demanding a secret belonging to a
 * system it is not supposed to touch:
 *
 *   Error: Missing required environment variable JWT_SECRET in production
 *     at config/env.js:25
 *     at services/email.service.js:2
 *
 * AND THE TESTS COULD NOT SEE IT. jobgan-e2e spawns the server with
 * NODE_ENV=development, where requireInProd does nothing. A failure that
 * exists only in production, in a service whose entire design claim is that it
 * shares no runtime with the gan — found by Render, which is the expensive
 * place to find it. jobgan-boot.test.js now boots it the way Render does.
 *
 * Forty lines of duplication is the price of the boundary being real. Anything
 * this service imports from ../services or ../config can drag the gan's
 * configuration in behind it, and next time it may not fail loudly.
 */

const FROM = process.env.JOBGAN_MAIL_FROM || 'ג׳וב חלום <noreply@jobgan.co.il>';

/**
 * Google Apps Script relay — the same web app the gan uses, reached by URL.
 * Chosen first because it needs no verified domain, which is the thing that is
 * not yet set up here.
 */
async function sendViaGAS({ to, cc, subject, html, text }) {
  const payload = JSON.stringify({
    secret: process.env.GAS_EMAIL_SECRET || '',
    to: Array.isArray(to) ? to : [to].filter(Boolean),
    cc: Array.isArray(cc) ? cc : (cc ? [cc] : []),
    subject,
    html,
    text: text || '',
    attachments: [],
    files: [],
  });

  // Two attempts. The relay drops the occasional connection, and a single
  // transient failure should not lose a gan's notification — but this is mail
  // about an application that is already safely stored, so it does not deserve
  // a long retry loop either.
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const res = await fetch(process.env.GAS_EMAIL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        redirect: 'follow',
        signal: ctrl.signal,
      });
      const body = await res.text();
      if (!res.ok) throw new Error(`GAS ${res.status}: ${body.slice(0, 120)}`);
      return { provider: 'gas' };
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('GAS send failed');
}

async function sendViaResend({ to, subject, html, text, from }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: from || FROM,
      to: Array.isArray(to) ? to : [to].filter(Boolean),
      subject,
      html,
      text: text || undefined,
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Resend ${res.status}: ${body.slice(0, 120)}`);
  return { provider: 'resend' };
}

/**
 * Whichever provider is configured. No provider is not a crash: the board must
 * run without one, and say so in the log rather than refuse applications.
 */
async function dispatch({ to, cc, subject, html, text, from }) {
  if (!to) throw new Error('no recipient');
  if (process.env.GAS_EMAIL_URL) return sendViaGAS({ to, cc, subject, html, text });
  if (process.env.RESEND_API_KEY) return sendViaResend({ to, subject, html, text, from });
  throw new Error('אין ספק מייל מוגדר (GAS_EMAIL_URL או RESEND_API_KEY)');
}

module.exports = { dispatch, FROM };
