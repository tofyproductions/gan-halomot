#!/usr/bin/env node
/**
 * An order that says it was sent, when it was not.
 *
 * Creating an order sends it to the supplier inside a try/catch that writes
 * the failure to console.error and nothing else. The order is saved, the
 * screen says it exists, and there is no field anywhere on it that records
 * whether the supplier was ever written to — the Order model had no email
 * fields at all. So a provider outage, a supplier with no address, or a
 * missing SMTP config all look exactly like a delivered order, and the first
 * anyone learns of it is the delivery that never comes.
 *
 * This does not detect a BOUNCE — a supplier's server accepting the message
 * and rejecting it minutes later still needs a mailbox to be read, which is a
 * separate piece of work. It closes the half that needs no mailbox: what this
 * server itself knows, at the moment it tries.
 *
 * The rule the fields exist to keep: sent is only ever written when a provider
 * actually accepted the message. Every other outcome is distinguishable from
 * it, including the outcomes nobody thought to raise as errors.
 *
 *   node scripts/order-delivery.test.js
 */

const { deliveryFromResult, deliveryFromError, EMAIL_NEVER } =
  require('../src/services/order-delivery.service');

let failures = 0;
const ok = (cond, label) => { console.log(`  ${cond ? '✅' : '❌'} ${label}`); if (!cond) failures++; };
const eq = (a, b, label) => {
  const good = a === b;
  console.log(`  ${good ? '✅' : '❌'} ${label}${good ? '' : `  (קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)})`}`);
  if (!good) failures++;
};

console.log('\n📦 מה באמת קרה למייל של ההזמנה\n');

console.log('נשלח');
{
  const d = deliveryFromResult({
    sent: true, messageId: '<abc@mail>', provider: 'resend',
    recipients: ['supplier@x.co.il', 'me@gan.co.il'],
  });
  eq(d.email_status, 'sent', 'ספק קיבל את ההודעה — ורק אז נרשם "נשלח"');
  eq(d.email_message_id, '<abc@mail>', 'מזהה ההודעה נשמר — בלעדיו אי אפשר יהיה לקשר החזרה');
  eq(d.email_recipients.length, 2, 'ומי הנמענים בפועל');
  eq(d.email_error, '', 'בלי שגיאה');
  ok(d.email_attempted_at instanceof Date, 'ומתי');
}

console.log('\nלא נשלח — וזה חייב להיראות אחרת');
{
  const noRec = deliveryFromResult({ skipped: true, reason: 'no-recipients' });
  eq(noRec.email_status, 'skipped', 'לספק אין כתובת — דילוג, לא שליחה');
  // "נמענים" does not contain "נמען" — the final nun is a different letter.
  ok(/נמענים/.test(noRec.email_error), 'והסיבה בעברית, כדי שתופיע על המסך כמו שהיא');

  const noProvider = deliveryFromResult({ skipped: true, reason: 'provider-not-configured' });
  eq(noProvider.email_status, 'skipped', 'מערכת המייל לא מוגדרת — גם זה דילוג');
  ok(noProvider.email_error !== noRec.email_error, 'ושתי הסיבות נבדלות זו מזו');

  const err = deliveryFromError(Object.assign(new Error('Invalid login'), { code: 'EAUTH' }));
  eq(err.email_status, 'failed', 'ספק החזיר שגיאה — נכשל');
  ok(/EAUTH/.test(err.email_error) && /Invalid login/.test(err.email_error),
    'הקוד וגם הטקסט נשמרים — בלי זה אי אפשר לתקן בלי גישה ללוג');
}

console.log('\nהמקרים שאף אחד לא חשב עליהם');
{
  // The point of the whole change: a result nobody anticipated must not be
  // able to read as a delivered order. Anything that is not an explicit
  // `sent: true` is not a send.
  eq(deliveryFromResult(undefined).email_status, 'failed', 'תוצאה ריקה אינה שליחה');
  eq(deliveryFromResult(null).email_status, 'failed', 'ו-null גם לא');
  eq(deliveryFromResult({}).email_status, 'failed', 'ואובייקט בלי sen — גם לא');
  eq(deliveryFromResult({ sent: false }).email_status, 'failed', 'ו-sent:false בוודאי שלא');
  eq(deliveryFromResult({ sent: 'yes' }).email_status, 'failed',
    'ואפילו ערך שנראה חיובי אך אינו true — רק true ממש נחשב');

  const bad = deliveryFromError(undefined);
  eq(bad.email_status, 'failed', 'חריגה בלי אובייקט שגיאה עדיין נכשלת');
  ok(bad.email_error.length > 0, 'ותמיד יש מה להראות למשתמש');
}

console.log('\nברירת המחדל');
{
  eq(EMAIL_NEVER, 'never', 'הזמנה שלא נעשה בה ניסיון כלל היא "never"');
  ok(EMAIL_NEVER !== 'sent', 'ולכן הזמנות ותיקות שקדמו לשדה לא ייקראו כאילו נשלחו');
}

console.log(`\n${failures === 0 ? '✅ הכול עבר' : `❌ ${failures} נכשלו`}\n`);
process.exit(failures === 0 ? 0 : 1);
