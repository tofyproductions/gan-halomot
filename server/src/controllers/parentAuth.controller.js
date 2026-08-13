const bcrypt = require('bcryptjs');
const { ParentAccount } = require('../models');
const { findParent, normalizeIdNumber, maskPhone } = require('../services/parentDirectory.service');
const otp = require('../services/parentOtp.service');
const { sendSms } = require('../services/sms.service');
const {
  signParentToken, signSetupToken, verifySetupToken,
} = require('../middleware/parentAuth');

const MIN_PASSWORD_LENGTH = 8;

/**
 * The sender ID on the message is the company's, not the gan's — one SMS
 * account serves several businesses, so a parent sees a name that means
 * nothing to them. The message has to introduce itself, and it has to do it
 * on the first line: a phone's notification preview shows that line and
 * often nothing else, which is where the decision to ignore it gets made.
 *
 * Hebrew SMS is billed in 70-character units and this wording lands at 67.
 * Three characters of headroom: a longer gan name, a seventh digit, or one
 * more word of politeness splits every code into two messages and doubles
 * the cost of the whole portal's messaging. Measure before editing this
 * string — it is closer to the edge than it looks.
 */
const ORG_NAME = 'גן החלומות';

function codeMessage(code) {
  return `קוד הכניסה שלך למערכת של ״${ORG_NAME}״ הוא: ${code}\nהקוד תקף ל-5 דקות`;
}

/**
 * Activation and reset are the same three steps: prove the phone, choose a
 * password, sign in. They are one flow here because they are one risk — both
 * end with somebody who can read the account, and the only thing standing in
 * front of either is the code.
 *
 * On enumeration: an unknown ID number is told so, plainly. The alternative —
 * answering every request identically — hides from an attacker that a given
 * ID belongs to a parent here, and hides from a parent who mistyped that they
 * mistyped. For a single gan the first is worth little (knowing somebody's
 * child attends is not a way in; the phone is) and the second costs a call to
 * the office every time. Should this ever face the open internet at scale, the
 * trade is worth revisiting.
 */

/** Step 1 — send a code to the phone we already hold for this parent. */
async function start(req, res) {
  const idNumber = normalizeIdNumber(req.body?.id_number);
  if (!idNumber) {
    return res.status(400).json({ error: 'יש להזין מספר תעודת זהות' });
  }

  const parent = await findParent(idNumber);
  if (!parent) {
    return res.status(404).json({
      error: 'לא נמצא ילד פעיל הרשום למספר תעודת הזהות הזה. לבירור יש לפנות לגן.',
    });
  }

  let account = await ParentAccount.findOne({ id_number: idNumber });

  if (account && !account.is_active) {
    return res.status(403).json({ error: 'החשבון סגור. לבירור יש לפנות לגן.' });
  }

  // A second parent nominated through the portal by the other parent waits for
  // the gan. Said plainly, because the alternative — a generic failure — sends
  // someone who has been told "I added you" into a loop of retrying a code
  // that will never be sent.
  if (account && !account.access_approved) {
    return res.status(403).json({
      error: 'הגישה שלך ממתינה לאישור הגן. נעדכן אותך כשהיא תיפתח.',
      code: 'AWAITING_APPROVAL',
    });
  }

  // The phone is taken from the enrolment record every time, never from the
  // account — so a number corrected by the office takes effect immediately,
  // and a stale one on the account can never outlive the correction.
  if (!parent.phone) {
    return res.status(409).json({
      error: 'לא רשום אצלנו מספר טלפון נייד עבורך. יש לפנות לגן כדי לעדכן אותו.',
      code: 'NO_PHONE_ON_RECORD',
    });
  }

  if (!account) {
    account = new ParentAccount({ id_number: idNumber });
  }
  account.phone = parent.phone;
  if (parent.full_name) account.full_name = parent.full_name;

  const gate = otp.canSend(account);
  if (!gate.ok) {
    return res.status(429).json({
      error: 'נשלח כבר קוד. יש להמתין לפני שליחה נוספת.',
      retry_after_seconds: gate.retryAfterSeconds,
    });
  }

  const code = otp.issueCode(account);

  // Send first, save second. A provider failure must not leave the account
  // holding a code nobody received while the previous one is already gone.
  try {
    await sendSms({ to: parent.phone, text: codeMessage(code) });
  } catch (err) {
    console.error('[parent-auth] SMS send failed:', err.message);
    return res.status(502).json({
      error: 'שליחת הקוד נכשלה. נסו שוב בעוד רגע, ואם זה חוזר — פנו לגן.',
    });
  }

  await account.save();

  return res.json({
    ok: true,
    mode: account.activated ? 'reset' : 'activate',
    phone_hint: maskPhone(parent.phone),
  });
}

/** Step 2 — check the code and hand back a ten-minute ticket. */
async function verify(req, res) {
  const idNumber = normalizeIdNumber(req.body?.id_number);
  const account = idNumber ? await ParentAccount.findOne({ id_number: idNumber }) : null;
  if (!account) {
    return res.status(404).json({ error: 'לא נמצא חשבון. יש להתחיל מחדש.' });
  }
  if (!account.is_active) {
    return res.status(403).json({ error: 'החשבון סגור. לבירור יש לפנות לגן.' });
  }

  const result = otp.verifyCode(account, req.body?.code);
  await account.save();

  if (!result.ok) {
    const messages = {
      no_code: 'לא נשלח קוד. יש להתחיל מחדש.',
      expired: 'הקוד פג תוקף. יש לבקש קוד חדש.',
      too_many_attempts: 'יותר מדי ניסיונות. יש לבקש קוד חדש.',
      wrong: 'הקוד שגוי.',
    };
    return res.status(400).json({
      error: messages[result.reason] || 'הקוד שגוי.',
      code: result.reason,
    });
  }

  return res.json({
    ok: true,
    setup_token: signSetupToken(account, 'set_password'),
    full_name: account.full_name || '',
  });
}

/** Step 3 — choose a password. Completes activation, and signs in. */
async function setPassword(req, res) {
  const { setup_token: setupToken, password } = req.body || {};

  if (!password || String(password).length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({
      error: `הסיסמה חייבת להכיל לפחות ${MIN_PASSWORD_LENGTH} תווים`,
    });
  }

  let decoded;
  try {
    decoded = verifySetupToken(setupToken, 'set_password');
  } catch {
    return res.status(401).json({ error: 'פג הזמן לבחירת סיסמה. יש להתחיל מחדש.' });
  }

  const account = await ParentAccount.findById(decoded.pid);
  if (!account || !account.is_active) {
    return res.status(403).json({ error: 'החשבון סגור. לבירור יש לפנות לגן.' });
  }

  account.password_hash = bcrypt.hashSync(String(password), 10);
  account.activated = true;
  account.last_login_at = new Date();
  otp.clearCode(account);
  await account.save();

  return res.json({ ok: true, token: signParentToken(account), full_name: account.full_name || '' });
}

/** The everyday door: ID number and password. */
async function login(req, res) {
  const idNumber = normalizeIdNumber(req.body?.id_number);
  const { password } = req.body || {};

  const account = idNumber ? await ParentAccount.findOne({ id_number: idNumber }) : null;

  // An account that exists but was never activated is not a login failure —
  // saying "wrong password" would send a parent hunting for a password they
  // never chose.
  if (!account || !account.activated || !account.password_hash) {
    return res.status(401).json({
      error: 'החשבון עדיין לא הופעל. יש להתחיל בהפעלת חשבון.',
      code: 'NOT_ACTIVATED',
    });
  }
  if (!account.is_active) {
    return res.status(403).json({ error: 'החשבון סגור. לבירור יש לפנות לגן.' });
  }
  if (!password || !bcrypt.compareSync(String(password), account.password_hash)) {
    return res.status(401).json({ error: 'תעודת זהות או סיסמה שגויים' });
  }

  // Still a parent of an active child? The account is closed by hand, but a
  // family that left and was never marked is caught here rather than shown a
  // portal with nothing in it.
  const parent = await findParent(idNumber);
  if (!parent) {
    return res.status(403).json({ error: 'החשבון סגור. לבירור יש לפנות לגן.' });
  }

  account.last_login_at = new Date();
  await account.save();

  return res.json({ ok: true, token: signParentToken(account), full_name: account.full_name || '' });
}

/** Who am I, and which children are mine — resolved fresh on every call. */
async function me(req, res) {
  const account = await ParentAccount.findById(req.parent.pid).lean();
  if (!account || !account.is_active) {
    return res.status(403).json({ error: 'החשבון סגור. לבירור יש לפנות לגן.' });
  }

  const parent = await findParent(account.id_number);
  if (!parent) {
    return res.status(403).json({ error: 'החשבון סגור. לבירור יש לפנות לגן.' });
  }

  return res.json({
    full_name: account.full_name || parent.full_name || '',
    phone_hint: maskPhone(account.phone),
    has_passkey: (account.webauthn_credentials || []).length > 0,
    // One entry per child, not per enrolment. A family in its second year has
    // two rows per child and listing them raw showed a parent the same son
    // twice, under the same name.
    children: parent.groups.map(g => ({
      id: g.current._id,
      name: g.current.child_name,
      birth_date: g.current.birth_date,
      classroom: g.current.classroom_id?.name || null,
      classroom_category: g.current.classroom_id?.category || null,
      academic_year: g.current.academic_year,
      years: g.years.length,
    })),
  });
}

module.exports = { start, verify, setPassword, login, me };
