/**
 * What actually happened when this order was mailed to the supplier.
 *
 * Creating an order sent it inside a try/catch that wrote the failure to
 * console.error and nothing else. The order saved, the screen showed it, and
 * nothing on the record said whether the supplier had ever been written to —
 * the Order model carried no email fields at all. A provider outage, a
 * supplier with no address and a missing SMTP config were indistinguishable
 * from a delivered order, and the first anyone learned of any of them was the
 * delivery that never arrived.
 *
 * This is the half that needs no mailbox: what this server knows at the moment
 * it tries. A supplier's server ACCEPTING the message and rejecting it minutes
 * later is a bounce, it arrives as mail, and catching it means reading a
 * mailbox — separate work. `email_message_id` is stored so that work has
 * something to match a bounce against when it happens.
 *
 * The rule: `sent` is written only when a provider explicitly accepted the
 * message. Everything else — including outcomes nobody thought to raise as an
 * error — must be distinguishable from it. An unrecognised result is a
 * failure, not a success, because the cost of the two mistakes is not
 * symmetrical: a false failure gets looked at, a false success gets believed.
 */

/** No attempt has been made. The default, and what every pre-existing order reads as. */
const EMAIL_NEVER = 'never';

const REASONS = {
  'no-recipients': 'אין נמענים — לספק לא הוגדרה כתובת מייל',
  'provider-not-configured': 'מערכת המייל אינה מוגדרת בשרת',
};

/** The patch to write on the order after sendOrderEmail returned. */
function deliveryFromResult(result) {
  const now = new Date();

  if (result && result.sent === true) {
    return {
      email_status: 'sent',
      email_attempted_at: now,
      email_message_id: String(result.messageId || ''),
      email_recipients: (result.recipients || []).filter(Boolean).map(String),
      email_error: '',
    };
  }

  if (result && result.skipped) {
    return {
      email_status: 'skipped',
      email_attempted_at: now,
      email_message_id: '',
      email_recipients: [],
      email_error: REASONS[result.reason] || `לא נשלח (${result.reason || 'ללא סיבה'})`,
    };
  }

  // Anything else. sendOrderEmail is supposed to return one of the two shapes
  // above; if it ever returns a third, the order must not claim it was sent.
  return {
    email_status: 'failed',
    email_attempted_at: now,
    email_message_id: '',
    email_recipients: [],
    email_error: 'תשובה לא מזוהה ממערכת המייל',
  };
}

/** The patch to write when sendOrderEmail threw. */
function deliveryFromError(err) {
  const code = err && (err.code || err.responseCode);
  const message = (err && err.message) || 'שגיאה לא ידועה';
  return {
    email_status: 'failed',
    email_attempted_at: new Date(),
    email_message_id: '',
    email_recipients: [],
    // The code alone is unreadable and the message alone is often generic.
    // Both, so somebody can fix an app password without server log access.
    email_error: code ? `${code}: ${message}` : message,
  };
}

module.exports = { EMAIL_NEVER, deliveryFromResult, deliveryFromError };
