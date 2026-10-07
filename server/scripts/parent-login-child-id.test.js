#!/usr/bin/env node
/**
 * A PARENT WHO SIGNS IN WITH THEIR CHILD'S NUMBER.
 *
 * The portal asked for the parent's own ת"ז and nothing else, and that was its
 * commonest refusal: nine digits recalled from memory against nine digits
 * somebody else copied off a registration form. A parent who cannot get their
 * own number right can always get their child's right, and the child's number
 * is on the same records.
 *
 * What has to hold once the second number is accepted:
 *
 *   the account stays the PARENT's — a child's number resolves to a person,
 *     it never becomes an identity of its own;
 *   the parent's own number still wins, even if some child carries the same
 *     digits, so a child record can never shadow a real account;
 *   a child with two parents is NOT guessed at — the caller is shown both and
 *     must choose, and nothing is texted until they do;
 *   the choice is carried by an opaque signed ref, so the parent's real ת"ז
 *     never reaches the browser;
 *   the code still goes only to the mobile on the gan's records;
 *   the list shows first names and masked numbers, which is what a parent
 *     needs to recognise themselves and all an outsider learns;
 *   an inactive child's number opens nothing;
 *   and a ref is not a credential: another key's token, or a token of another
 *     kind, is refused.
 *
 *   node scripts/parent-login-child-id.test.js
 */
try { require.resolve('mongodb-memory-server'); } catch {
  console.error('\n❌  חסרה חבילת הבדיקה. הרץ:\n\n   npm install --no-save mongodb-memory-server\n');
  process.exit(1);
}

// server/.env on this machine points at PRODUCTION. Neutralise dotenv before
// anything can read it — the same guard parent-portal-authz uses.
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};

const { MongoMemoryServer } = require('mongodb-memory-server');

let failures = 0;
const ok = (cond, label, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${label}${!cond && detail ? `  (${detail})` : ''}`);
  if (!cond) failures++;
  return !!cond;
};

(async () => {
  const mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri() + 'gan_test';
  if (!/127\.0\.0\.1|localhost/.test(uri)) {
    console.error('\n❌  מסד הבדיקה אינו מקומי. עוצר.\n');
    process.exit(1);
  }
  process.env.MONGODB_URI = uri;
  process.env.JWT_SECRET = 'parent-child-id-test';
  process.env.SMS_KEY = 'k'; process.env.SMS_USER = 'u';
  process.env.SMS_PASS = 'p'; process.env.SMS_SENDER = 'test';
  delete process.env.PLATFORM_MONGODB_URI;

  const mongoose = require('mongoose');
  const jwt = require('jsonwebtoken');
  await mongoose.connect(uri);

  const { Registration, Child, ParentAccount } = require('../src/models');

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
  app.use('/api/parent', require('../src/routes/parent.routes'));
  app.use((err, req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/parent`;

  const post = async (path, body) => {
    const r = await realFetch(base + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const get = async (path, token) => {
    const r = await realFetch(base + path, { headers: { Authorization: `Bearer ${token}` } });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  // ------------------------------------------------------------------ the data
  const YEAR = '2026-2027';
  // A window around today, so currentEnrolment picks the row being lived
  // rather than next year's — the bug that once showed a parent the wrong
  // classroom all through August.
  const NOW = new Date();
  const DATES = {
    start_date: new Date(NOW.getFullYear(), NOW.getMonth() - 1, 1),
    end_date: new Date(NOW.getFullYear() + 1, NOW.getMonth(), 1),
  };
  const DAD = { id: '111111118', name: 'יוסי לוי', phone: '0521111111' };
  const MUM = { id: '222222226', name: 'דנה לוי', phone: '0522222222' };
  const SOLO = { id: '333333334', name: 'אורית כהן', phone: '0523333333' };
  const TWINLESS = { id: '444444442', name: 'רון מזרחי', phone: '0524444444' };

  // Two parents on the card. The usual shape: 148 of the gan's 161 children
  // with a number look like this, so the picker is the common path, not a
  // corner.
  const reg1 = await Registration.create({
    unique_id: 'R1', child_name: 'נועם לוי', parent_name: DAD.name,
    parent_id_number: DAD.id, parent_phone: DAD.phone, monthly_fee: 2000, ...DATES,
  });
  await Child.create({
    registration_id: reg1._id, child_name: 'נועם לוי', child_id_number: '555555550',
    academic_year: YEAR, is_active: true,
    parent_name: DAD.name, parent_id_number: DAD.id, phone: DAD.phone,
    parent2_name: MUM.name, parent2_id_number: MUM.id, parent2_phone: MUM.phone,
  });

  // One parent, and only on the registration behind the child — the path that
  // answers for the families whose child card carries no parent id at all.
  const reg2 = await Registration.create({
    unique_id: 'R2', child_name: 'תמר כהן', parent_name: SOLO.name,
    parent_id_number: SOLO.id, parent_phone: SOLO.phone, monthly_fee: 2000, ...DATES,
  });
  await Child.create({
    registration_id: reg2._id, child_name: 'תמר כהן', child_id_number: '666666668',
    academic_year: YEAR, is_active: true,
  });

  // A child who left. Marked inactive, which is the only thing that closes the
  // door — no dates anywhere.
  const reg3 = await Registration.create({
    unique_id: 'R3', child_name: 'איתי מזרחי', parent_name: TWINLESS.name,
    parent_id_number: TWINLESS.id, parent_phone: TWINLESS.phone, monthly_fee: 2000, ...DATES,
  });
  await Child.create({
    registration_id: reg3._id, child_name: 'איתי מזרחי', child_id_number: '777777776',
    academic_year: YEAR, is_active: false,
    parent_name: TWINLESS.name, parent_id_number: TWINLESS.id, phone: TWINLESS.phone,
  });

  // The same child, enrolled a second year. One ת"ז on two active rows, which
  // is what the gan's data actually holds — the father must be offered once.
  await Child.create({
    registration_id: reg1._id, child_name: 'נועם לוי', child_id_number: '555555550',
    academic_year: '2025-2026', is_active: true,
    parent_name: DAD.name, parent_id_number: DAD.id, phone: DAD.phone,
    parent2_name: MUM.name, parent2_id_number: MUM.id, parent2_phone: MUM.phone,
  });

  const clearThrottle = (id) => ParentAccount.updateOne({ id_number: id },
    { otp_sent_at: null, otp_window_started_at: null, otp_sends_in_window: 0 });

  console.log('\n👪 כניסת הורה עם ת"ז של הילד\n');

  // ------------------------------------------------- the parent's own number
  console.log('הת"ז של ההורה — כמו קודם');
  sent.length = 0;
  const own = await post('/auth/start', { id_number: DAD.id });
  ok(own.status === 200 && own.body.ok === true, `נשלח קוד (${own.status})`);
  ok(sent.length === 1 && sent[0].to === DAD.phone, `לנייד של האב (${sent[0] && sent[0].to})`);
  ok(Boolean(own.body.login_ref), 'והוחזר כרטיס להמשך');

  // ------------------------------------------- a child with one parent on file
  console.log('\nת"ז של ילדה שלהורה אחד רשום');
  sent.length = 0;
  const solo = await post('/auth/start', { id_number: '666666668' });
  ok(solo.status === 200 && solo.body.ok === true, `נפתר ללא שאלה (${solo.status})`);
  ok(!solo.body.choose_parent, 'בלי מסך בחירה');
  ok(sent.length === 1 && sent[0].to === SOLO.phone, `הקוד לנייד של האם (${sent[0] && sent[0].to})`);
  const soloRef = solo.body.login_ref;
  ok(Boolean(soloRef), 'והוחזר כרטיס להמשך');
  ok(!JSON.stringify(solo.body).includes(SOLO.id), 'והת"ז של ההורה לא חזרה לדפדפן');

  // the rest of the flow runs on the ref alone — the browser never sees the
  // parent's number, so it cannot send it back
  const verified = await post('/auth/verify', { login_ref: soloRef, code: codeFrom(sent[0].msg) });
  ok(verified.status === 200 && Boolean(verified.body.setup_token),
    `הקוד נבדק מול הכרטיס (${verified.status})`);
  const chose = await post('/auth/set-password', {
    setup_token: verified.body.setup_token, password: 'orit-12345',
  });
  ok(chose.status === 200 && Boolean(chose.body.token), `נבחרה סיסמה ונכנסנו (${chose.status})`);
  const me = await get('/me', chose.body.token);
  ok(me.status === 200, `האזור האישי נפתח (${me.status})`);
  ok((me.body.children || []).length === 1 && me.body.children[0].name === 'תמר כהן',
    'ומראה את הילדה הנכונה', JSON.stringify(me.body.children));
  const acct = await ParentAccount.findOne({ id_number: SOLO.id });
  ok(Boolean(acct) && acct.activated === true, 'והחשבון שנפתח הוא של ההורה, לא של הילדה');

  // ------------------------------------------ a child with two parents on file
  console.log('\nת"ז של ילד ששני הורים רשומים לו');
  sent.length = 0;
  const two = await post('/auth/start', { id_number: '555555550' });
  ok(two.status === 200 && two.body.choose_parent === true, `מוצגת בחירה (${two.status})`);
  ok(sent.length === 0, 'ולא נשלחה אף הודעה לפני שבחרו');
  const cands = two.body.candidates || [];
  ok(cands.length === 2, `שני מועמדים — לא ארבעה, למרות שתי שנות רישום (${cands.length})`);
  const names = cands.map((c) => c.first_name).sort();
  ok(JSON.stringify(names) === JSON.stringify(['דנה', 'יוסי']),
    'שמות פרטיים בלבד', JSON.stringify(names));
  ok(cands.every((c) => !/לוי/.test(JSON.stringify(c))),
    'בלי שם משפחה — לא של ההורים ולא של הילד', JSON.stringify(cands));
  ok(cands.every((c) => c.child_name === 'נועם'), 'שם הילד מוצג כשם פרטי בלבד');
  ok(cands.every((c) => /^05.{6}\d\d$/.test(c.phone_hint || '')),
    'נייד ממוסך', JSON.stringify(cands.map((c) => c.phone_hint)));
  ok(cands.every((c) => c.can_receive === true), 'שניהם יכולים לקבל קוד');
  const raw = JSON.stringify(two.body);
  ok(!raw.includes(DAD.id) && !raw.includes(MUM.id), 'ואף ת"ז של הורה לא חזרה לדפדפן');
  ok(!raw.includes(DAD.phone) && !raw.includes(MUM.phone), 'וגם לא נייד מלא');

  // ----------------------------------------------- the code goes where they said
  console.log('\nבוחרים את האם');
  const mumRef = cands.find((c) => c.first_name === 'דנה').parent_ref;
  sent.length = 0;
  const picked = await post('/auth/start', { id_number: '555555550', parent_ref: mumRef });
  ok(picked.status === 200 && picked.body.ok === true, `נשלח קוד (${picked.status})`);
  ok(sent.length === 1, 'הודעה אחת');
  ok(sent[0].to === MUM.phone, `רק לנייד של האם (${sent[0].to})`);
  ok(sent[0].to !== DAD.phone, 'ולא לנייד של האב');

  // ------------------------------------------------- the parent's number wins
  console.log('\nמספר שהוא גם של הורה וגם של ילד');
  // The father's own number, planted as some other child's id as well.
  const regX = await Registration.create({
    unique_id: 'R4', child_name: 'ילד אחר', parent_name: TWINLESS.name,
    parent_id_number: TWINLESS.id, parent_phone: TWINLESS.phone, monthly_fee: 2000, ...DATES,
  });
  await Child.create({
    registration_id: regX._id, child_name: 'ילד אחר', child_id_number: DAD.id,
    academic_year: YEAR, is_active: true,
    parent_name: TWINLESS.name, parent_id_number: TWINLESS.id, phone: TWINLESS.phone,
  });
  await clearThrottle(DAD.id);
  sent.length = 0;
  const clash = await post('/auth/start', { id_number: DAD.id });
  ok(clash.body.ok === true && !clash.body.choose_parent, 'נפתר כהורה, בלי בחירה');
  ok(sent.length === 1 && sent[0].to === DAD.phone,
    `והקוד לנייד שלו, לא של הורה של ילד אחר (${sent[0] && sent[0].to})`);

  // ------------------------------------------------------- doors that stay shut
  console.log('\nמה שלא נפתח');
  sent.length = 0;
  const gone = await post('/auth/start', { id_number: '777777776' });
  ok(gone.status === 404, `ת"ז של ילד שעזב — 404 (${gone.status})`);
  ok(!gone.body.candidates, 'ובלי רשימת הורים');

  const nonsense = await post('/auth/start', { id_number: '999999999' });
  ok(nonsense.status === 404, `מספר שאינו אצלנו — 404 (${nonsense.status})`);

  const partial = await post('/auth/start', { id_number: '5555' });
  ok(partial.status === 404 && !partial.body.candidates,
    `חצי מספר לא מחזיר התאמות (${partial.status})`);

  const empty = await post('/auth/start', { id_number: '' });
  ok(empty.status === 400, `בלי מספר — 400 (${empty.status})`);
  ok(sent.length === 0, 'ואף הודעה לא נשלחה בכל אלה');

  // ---------------------------------------------------------- a ref is not a key
  console.log('\nכרטיס הבחירה אינו אישור');
  const forged = jwt.sign({ id_number: DAD.id, typ: 'parent_lookup' },
    process.env.JWT_SECRET, { expiresIn: '10m' });
  const forgedTry = await post('/auth/start', { id_number: '555555550', parent_ref: forged });
  ok(forgedTry.status === 401, `כרטיס חתום במפתח הצוות נדחה (${forgedTry.status})`);

  const { signSetupToken } = require('../src/middleware/parentAuth');
  const wrongType = signSetupToken({ _id: acct._id }, 'set_password');
  const wrongTypeTry = await post('/auth/start', { id_number: '555555550', parent_ref: wrongType });
  ok(wrongTypeTry.status === 401, `כרטיס מסוג אחר נדחה (${wrongTypeTry.status})`);

  const garbage = await post('/auth/start', { id_number: '555555550', parent_ref: 'not-a-token' });
  ok(garbage.status === 401, `זבל נדחה (${garbage.status})`);

  // --------------------------------------- the picker cannot appear on step two
  console.log('\nשלב הקוד לא מציג בחירה');
  const strayVerify = await post('/auth/verify', { id_number: '555555550', code: '123456' });
  ok(strayVerify.status === 409, `נשלחים להתחיל מחדש (${strayVerify.status})`);

  // ------------------------------------- the everyday password login, by child
  console.log('\nכניסה יומיומית עם ת"ז של הילדה');
  const byChild = await post('/auth/login', { id_number: '666666668', password: 'orit-12345' });
  ok(byChild.status === 200 && Boolean(byChild.body.token),
    `הסיסמה של ההורה פותחת (${byChild.status})`);

  const twoLogin = await post('/auth/login', { id_number: '555555550', password: 'whatever' });
  ok(twoLogin.body.choose_parent === true, 'ילד עם שני הורים — נשאלים קודם מי מדבר');
  ok(!twoLogin.body.token, 'ובלי אסימון');

  const wrongPw = await post('/auth/login', { id_number: '666666668', password: 'not-it' });
  ok(wrongPw.status === 401 && !wrongPw.body.token,
    `סיסמה שגויה נדחית גם במסלול הזה (${wrongPw.status})`);

  console.log(failures === 0 ? `\n✅  הכל עבר\n` : `\n❌  ${failures} נכשלו\n`);
  await mongoose.disconnect();
  server.close();
  await mongo.stop();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('\n💥', e); process.exit(1); });
