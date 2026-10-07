#!/usr/bin/env node
/**
 * A FIRST SIGN-IN, AND THE DOOR THAT USED TO BE OPEN.
 *
 * Until 07.10.2026 a member of staff with no password chosen could sign in on
 * a name and a ת"ז, and get a full token. In a gan everybody knows everybody's
 * name, and a ת"ז is printed on documents and copied into forms — so the pair
 * was a way of saying who you are, not of proving it. Sixty of the gan's
 * seventy-three active accounts had never chosen a password, and each of them
 * was an account a colleague could open first and then set a password on,
 * locking out the person it belongs to.
 *
 * So the things worth proving here are the refusals, not the happy path:
 *
 *   name + ת"ז alone issues NO token, ever;
 *   a code is texted to the mobile already on the records — never to one in
 *     the request;
 *   nothing else lets somebody past: not login-password, not a fingerprint;
 *   a wrong code sets no password;
 *   the right code, with a password, is what finally signs them in;
 *   and from then on it is the password screen, with no more texts;
 *   an account with no mobile anywhere is refused and told who can fix it,
 *     rather than being let through because the guard cannot run.
 *
 *   node scripts/staff-first-login-otp.test.js
 */
try { require.resolve('mongodb-memory-server'); } catch {
  console.error('\n❌  חסרה חבילת הבדיקה. הרץ:\n\n   npm install --no-save mongodb-memory-server\n');
  process.exit(1);
}

const { MongoMemoryServer } = require('mongodb-memory-server');

let failures = 0;
const ok = (cond, label) => { console.log(`  ${cond ? '✅' : '❌'} ${label}`); if (!cond) failures++; };

(async () => {
  const mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri() + 'gan_test';
  process.env.JWT_SECRET = 'first-login-otp-test';
  process.env.SMS_KEY = 'k'; process.env.SMS_USER = 'u';
  process.env.SMS_PASS = 'p'; process.env.SMS_SENDER = 'test';
  delete process.env.PLATFORM_MONGODB_URI;

  const mongoose = require('mongoose');
  await mongoose.connect(process.env.MONGODB_URI);

  const bcrypt = require('bcryptjs');
  const { User, Employee, Branch } = require('../src/models');

  // password_hash is required on the model even before anybody has chosen a
  // password, so a brand-new account carries one nobody knows. That is the
  // real shape of the sixty accounts this test is about.
  const UNKNOWN_HASH = () => bcrypt.hash(require('crypto').randomBytes(24).toString('hex'), 10);

  // The provider, replaced by a spy. The code is only ever legible in the SMS,
  // which is the point — so this is the only place the test can read it.
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes('sms4free')) {
      const body = JSON.parse(opts.body);
      sent.push({ to: body.recipient, msg: body.msg });
      return { ok: true, status: 200, text: async () => '{"status":1,"message":"Succeeded"}' };
    }
    return realFetch(url, opts);
  };
  const codeFrom = (msg) => (String(msg).match(/\b(\d{6})\b/) || [])[1];

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../src/routes/auth.routes'));
  app.use((err, req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/auth`;

  const post = async (path, body) => {
    const r = await realFetch(base + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  const branch = await Branch.create({ name: 'סניף בדיקה' });

  // The ordinary case: a login with no password, and her mobile only on the
  // employee card — which is where most of the gan's numbers actually live.
  const NAME = 'שירה כהן', ID = '123456789', PHONE = '052-123-4567';
  await Employee.create({
    full_name: NAME, israeli_id: ID, phone: PHONE, branch_id: branch._id, is_active: true,
  });
  const user = await User.create({
    full_name: NAME, id_number: ID, email: 'shira@example.invalid',
    role: 'teacher', is_active: true, password_set: false,
    password_hash: await UNKNOWN_HASH(),
  });

  // Nobody has her number — not the user, not the employee card. Three of the
  // gan's real accounts were in exactly this state.
  const MUTE_NAME = 'אופק אהרון', MUTE_ID = '314874413';
  await User.create({
    full_name: MUTE_NAME, id_number: MUTE_ID, email: 'ofek@example.invalid',
    role: 'teacher', is_active: true, password_set: false,
    password_hash: await UNKNOWN_HASH(),
  });

  const reload = () => User.findById(user._id);
  const clearThrottle = () => User.updateOne({ _id: user._id },
    { otp_sent_at: null, otp_window_started_at: null, otp_sends_in_window: 0 });

  console.log('\n🔐 כניסה ראשונה של עובדת\n');

  // --------------------------------------------- name + id issues no token
  console.log('שם ות"ז לבד — לא פותחים כלום');
  sent.length = 0;
  const first = await post('/login', { full_name: NAME, id_number: ID });
  ok(first.status === 200, `הבקשה נענית (${first.status})`);
  ok(first.body.needs_activation === true, 'נדרשת הפעלה');
  ok(!first.body.token, 'לא הונפק אסימון');
  ok(!first.body.user, 'לא הוחזר משתמש');
  ok(sent.length === 1, 'נשלחה הודעה אחת');
  ok(sent[0] && sent[0].to === '0521234567', `ההודעה לנייד שבכרטיס העובדת (${sent[0] && sent[0].to})`);
  ok(/05.{6}67/.test(first.body.phone_hint || ''), `הנייד מוצג ממוסך (${first.body.phone_hint})`);
  const liveCode = codeFrom(sent[0] && sent[0].msg);
  ok(/^\d{6}$/.test(liveCode || ''), 'ההודעה נושאת קוד בן שש ספרות');
  ok(!JSON.stringify(first.body).includes(liveCode), 'הקוד אינו חוזר בתשובת השרת');

  // --------------------------------------------- a number in the request is ignored
  console.log('\nנייד שמוקלד בבקשה — לא מקבל כלום');
  await clearThrottle();
  sent.length = 0;
  await post('/login', { full_name: NAME, id_number: ID, phone: '0500000000' });
  ok(sent.length === 1 && sent[0].to === '0521234567',
    `ההודעה עדיין לנייד שלנו (${sent[0] && sent[0].to})`);

  // --------------------------------------------- nothing else gets past
  console.log('\nבלי הקוד — אין דרך אחרת');
  const guessed = await post('/login-password', { full_name: NAME, id_number: ID, password: 'anything-at-all' });
  ok(guessed.status === 401 && !guessed.body.token, `login-password נדחה (${guessed.status})`);

  const bio = await post('/webauthn/auth/options', { userId: String(user._id) });
  ok(bio.status === 403 && bio.body.code === 'ACTIVATION_REQUIRED',
    `טביעת אצבע נדחית עד להפעלה (${bio.status} ${bio.body.code || ''})`);
  const bioVerify = await post('/webauthn/auth/verify', { userId: String(user._id), credential: { id: 'x' } });
  ok(bioVerify.status === 403, `אימות ביומטרי נדחה גם הוא (${bioVerify.status})`);

  // --------------------------------------------- a wrong code changes nothing
  console.log('\nקוד שגוי');
  const wrong = await post('/reset-with-code', {
    full_name: NAME, id_number: ID, code: '000000', password: 'a-new-password',
  });
  ok(wrong.status === 400 && !wrong.body.token, `נדחה בלי אסימון (${wrong.status})`);
  ok((await reload()).password_set === false, 'לא נקבעה סיסמה');

  // --------------------------------------------- reload mid-flow is not an error
  console.log('\nרענון באמצע — הקוד החי נשאר חי');
  sent.length = 0;
  const again = await post('/login', { full_name: NAME, id_number: ID });
  ok(again.status === 200 && again.body.needs_activation === true,
    `מגיעים שוב למסך הקוד (${again.status})`);
  ok(again.body.already_sent === true, 'נאמר שהקוד כבר נשלח');
  ok(sent.length === 0, 'ולא נשלחה הודעה נוספת');

  // --------------------------------------------- the code, and a password
  console.log('\nהקוד הנכון וסיסמה');
  await clearThrottle();
  sent.length = 0;
  await post('/login', { full_name: NAME, id_number: ID });
  const code = codeFrom(sent[0].msg);
  const activated = await post('/reset-with-code', {
    full_name: NAME, id_number: ID, code, password: 'shira-1234',
  });
  ok(activated.status === 200 && Boolean(activated.body.token), `נכנסת (${activated.status})`);
  const after = await reload();
  ok(after.password_set === true, 'הסיסמה נקבעה');
  ok(after.must_change_password === false, 'ואין חובת החלפה — היא בחרה אותה בעצמה');

  // --------------------------------------------- and from now on, the password
  console.log('\nמהכניסה הבאה — סיסמה, בלי הודעות');
  sent.length = 0;
  const next = await post('/login', { full_name: NAME, id_number: ID });
  ok(next.body.needs_password === true, 'נדרשת סיסמה');
  ok(!next.body.needs_activation, 'ולא הפעלה מחדש');
  ok(!next.body.token, 'ושוב בלי אסימון בשלב הזה');
  ok(sent.length === 0, 'לא נשלחה הודעה');

  const withPw = await post('/login-password', {
    full_name: NAME, id_number: ID, password: 'shira-1234',
  });
  ok(withPw.status === 200 && Boolean(withPw.body.token), `הסיסמה פותחת (${withPw.status})`);

  // --------------------------------------------- no mobile anywhere
  console.log('\nעובדת בלי נייד ברשומות');
  sent.length = 0;
  const mute = await post('/login', { full_name: MUTE_NAME, id_number: MUTE_ID });
  ok(mute.status === 400, `נחסמת (${mute.status})`);
  ok(mute.body.code === 'NO_PHONE_ON_RECORD', `עם סיבה שאפשר לפעול לפיה (${mute.body.code})`);
  ok(!mute.body.token, 'ובלי אסימון');
  ok(/מנהל/.test(mute.body.error || ''), 'וההודעה אומרת למי לפנות');
  ok(sent.length === 0, 'לא נשלחה הודעה');

  // --------------------------------------------- a colleague who knows the pair
  console.log('\nעמיתה שיודעת את השם והת"ז');
  const colleague = await post('/login', { full_name: NAME, id_number: ID });
  ok(!colleague.body.token, 'לא מקבלת אסימון');
  ok(colleague.body.needs_password === true,
    'ונשלחת למסך סיסמה שאין לה — הקוד כבר הגיע לנייד של העובדת');

  console.log(failures === 0 ? `\n✅  הכל עבר\n` : `\n❌  ${failures} נכשלו\n`);
  await mongoose.disconnect();
  server.close();
  await mongo.stop();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('\n💥', e); process.exit(1); });
