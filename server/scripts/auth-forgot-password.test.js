#!/usr/bin/env node
/**
 * "שכחתי סיסמה" — the code, and everything that can go wrong with it.
 *
 * This is the one place where a stranger with a name and a national id can
 * cause an SMS to be sent and, if they read it, take over a login that can see
 * every child's file and every salary. So the things worth proving are not
 * "does it reset a password" — they are the refusals:
 *
 *   the code goes to the phone WE hold, never to one in the request;
 *   a wrong code is counted and the fifth one kills the code;
 *   an expired code is dead;
 *   a used code cannot be used twice;
 *   a second request inside a minute is refused rather than sent;
 *   and a provider failure does not overwrite a working code with a
 *   ghost — because that would leave somebody holding a code that was
 *   never delivered and no way back to the one that was.
 *
 *   node scripts/auth-forgot-password.test.js
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
  process.env.JWT_SECRET = 'forgot-password-test';
  // Enough for sms.service.isConfigured(); the network call itself is stubbed.
  process.env.SMS_KEY = 'k'; process.env.SMS_USER = 'u';
  process.env.SMS_PASS = 'p'; process.env.SMS_SENDER = 'test';
  delete process.env.PLATFORM_MONGODB_URI;

  const mongoose = require('mongoose');
  await mongoose.connect(process.env.MONGODB_URI);

  const bcrypt = require('bcryptjs');
  const { User, Employee, Branch } = require('../src/models');

  // The provider, replaced by a spy. The real one would post to SMS4Free.
  const sent = [];
  let failNextSend = false;
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes('sms4free')) {
      const body = JSON.parse(opts.body);
      if (failNextSend) return { ok: false, status: 500, text: async () => 'boom' };
      sent.push({ to: body.recipient, msg: body.msg });
      return { ok: true, status: 200, text: async () => '{"status":1,"message":"Succeeded"}' };
    }
    return realFetch(url, opts);
  };

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

  // One employee with a login, and her phone only on the employee card — the
  // common case, and the one that used to make this feature unusable.
  const NAME = 'רונית לוי', ID = '123456789';
  const branch = await Branch.create({ name: 'סניף בדיקה' });
  await Employee.create({
    full_name: NAME, israeli_id: ID, phone: '052-123-4567',
    branch_id: branch._id, is_active: true,
  });
  const user = await User.create({
    full_name: NAME, id_number: ID, email: 'ronit@example.invalid',
    password_hash: await bcrypt.hash('old-password', 10),
    password_set: true, role: 'teacher', is_active: true,
  });

  const reload = () => User.findById(user._id);
  const clearThrottle = async () => User.updateOne({ _id: user._id },
    { otp_sent_at: null, otp_window_started_at: null, otp_sends_in_window: 0 });

  console.log('\n🔑 שכחתי סיסמה\n');

  // ------------------------------------------------------------ the code goes out
  let r = await post('/forgot-password', { full_name: NAME, id_number: ID });
  ok(r.status === 200 && r.body.ok, 'בקשת קוד מתקבלת');
  ok(sent.length === 1, 'ונשלחה בדיוק הודעה אחת');
  ok(sent[0] && sent[0].to === '0521234567', 'לטלפון שמופיע בכרטיס העובד, מנורמל');
  ok(/^\d{6}$/.test((sent[0]?.msg.match(/\d{6}/) || [])[0] || ''), 'ההודעה מכילה קוד בן שש ספרות');
  ok(r.body.phone_hint && !r.body.phone_hint.includes('1234'), 'המספר שחוזר למסך ממוסך');

  const code = (sent[0].msg.match(/\d{6}/) || [])[0];
  ok(!(await reload()).otp_hash?.includes(code), 'הקוד נשמר מגובב ולא כטקסט');

  // ------------------------------------------------------------ the phone is ours
  await clearThrottle();
  await post('/forgot-password', { full_name: NAME, id_number: ID, phone: '0500000000' });
  ok(sent[sent.length - 1].to === '0521234567', 'טלפון שנשלח בבקשה עצמה מתעלמים ממנו');

  // ------------------------------------------------------------ wrong guesses
  const stale = (sent[sent.length - 1].msg.match(/\d{6}/) || [])[0];
  const wrong = stale === '000000' ? '111111' : '000000';
  for (let i = 0; i < 4; i++) await post('/reset-with-code', { full_name: NAME, id_number: ID, code: wrong, password: 'abcd' });
  ok((await reload()).otp_attempts === 4, 'ניסיונות שגויים נספרים');
  r = await post('/reset-with-code', { full_name: NAME, id_number: ID, code: wrong, password: 'abcd' });
  ok(r.status === 400, 'הניסיון החמישי נדחה');
  ok(!(await reload()).otp_hash, 'והקוד נהרג אחרי חמישה ניסיונות');
  r = await post('/reset-with-code', { full_name: NAME, id_number: ID, code: stale, password: 'abcd' });
  ok(r.status === 400, 'אפילו הקוד הנכון כבר לא עובד אחרי שנהרג');

  // ------------------------------------------------------------ throttling
  await clearThrottle();
  await post('/forgot-password', { full_name: NAME, id_number: ID });
  r = await post('/forgot-password', { full_name: NAME, id_number: ID });
  ok(r.status === 429, 'בקשה שנייה תוך דקה נעצרת');

  // ------------------------------------------------------------ expiry
  await clearThrottle();
  await post('/forgot-password', { full_name: NAME, id_number: ID });
  const live = (sent[sent.length - 1].msg.match(/\d{6}/) || [])[0];
  await User.updateOne({ _id: user._id }, { otp_expires_at: new Date(Date.now() - 1000) });
  r = await post('/reset-with-code', { full_name: NAME, id_number: ID, code: live, password: 'abcd' });
  ok(r.status === 400 && /פג/.test(r.body.error || ''), 'קוד שפג נדחה, וההודעה אומרת שהוא פג');

  // ------------------------------------------------------------ the happy path
  await clearThrottle();
  await post('/forgot-password', { full_name: NAME, id_number: ID });
  const good = (sent[sent.length - 1].msg.match(/\d{6}/) || [])[0];
  r = await post('/reset-with-code', { full_name: NAME, id_number: ID, code: good, password: 'new-password' });
  ok(r.status === 200 && !!r.body.token, 'קוד נכון מאפס את הסיסמה ומחזיר טוקן — נכנסים ישר');

  const after = await reload();
  ok(await bcrypt.compare('new-password', after.password_hash), 'הסיסמה החדשה נשמרה');
  ok(!(await bcrypt.compare('old-password', after.password_hash)), 'והישנה כבר לא עובדת');
  ok(after.password_set === true && after.must_change_password === false, 'ולא נדרש שינוי סיסמה נוסף');
  ok(!after.otp_hash, 'הקוד נוצל ונמחק');

  r = await post('/reset-with-code', { full_name: NAME, id_number: ID, code: good, password: 'again1234' });
  ok(r.status === 400, 'ואי אפשר להשתמש בו פעם שנייה');

  // ------------------------------------------------------------ a provider failure
  await clearThrottle();
  const before = (await reload()).otp_hash;
  failNextSend = true;
  r = await post('/forgot-password', { full_name: NAME, id_number: ID });
  failNextSend = false;
  ok(r.status === 502, 'כשל אצל ספק ההודעות מוחזר ככשל');
  ok((await reload()).otp_hash === before, 'ולא נשמר קוד שאיש לא קיבל');

  // ------------------------------------------------------------ unknown person
  await clearThrottle();
  const nSent = sent.length;
  r = await post('/forgot-password', { full_name: 'לא קיימת', id_number: '999999999' });
  ok(r.status === 401, 'שם שלא קיים נדחה');
  ok(sent.length === nSent, 'ולא נשלחה שום הודעה');

  // ------------------------------------------------------------ nobody to text
  const noPhone = await User.create({
    full_name: 'בלי טלפון', id_number: '222222222', email: 'no@example.invalid',
    password_hash: await bcrypt.hash('x', 10), password_set: true, role: 'teacher', is_active: true,
  });
  r = await post('/forgot-password', { full_name: 'בלי טלפון', id_number: '222222222' });
  ok(r.status === 400 && /נייד/.test(r.body.error || ''), 'משתמש בלי נייד מקבל הסבר, לא כישלון סתום');
  await User.deleteOne({ _id: noPhone._id });

  global.fetch = realFetch;
  server.close();
  await mongoose.disconnect();
  await mongo.stop();

  console.log(failures ? `\n❌ ${failures} בדיקות נכשלו\n` : '\n✅ הכול עבר\n');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
