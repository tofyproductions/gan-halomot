#!/usr/bin/env node
/**
 * The form on the marketing page, end to end.
 *
 * It is the only unauthenticated write on the control plane, and the only place
 * a stranger's input reaches it. So the things worth proving are not "does it
 * save" — it is what happens on the bad days: a bot filling every field, a
 * person pressing the button twice, a phone number typed with hyphens, and the
 * notification email failing while the lead itself must survive.
 *
 * The last one is the reason this file exists. A form that emails and does not
 * store loses the lead silently the day the mail key expires, and nothing tells
 * anybody. Here that case is asserted: the row is present and it says so.
 *
 *   node scripts/ganflow-signup.test.js
 */
try { require.resolve('mongodb-memory-server'); } catch {
  console.error('\n❌  חסרה חבילת הבדיקה. הרץ:\n\n   npm install --no-save mongodb-memory-server\n');
  process.exit(1);
}

const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient } = require('mongodb');

let failures = 0;
const ok = (cond, label) => { console.log(`  ${cond ? '✅' : '❌'} ${label}`); if (!cond) failures++; };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const mongo = await MongoMemoryServer.create();
  const base = mongo.getUri();
  process.env.PLATFORM_MONGODB_URI = base + 'gf_control';
  process.env.MONGODB_URI = base + 'gf_unused';
  process.env.PLATFORM_JWT_SECRET = 'test-secret-not-a-real-one';
  // No mail provider on purpose — the notification MUST fail, so that the
  // "saved anyway, and said so" case is the one under test.
  delete process.env.GAS_EMAIL_URL;
  delete process.env.RESEND_API_KEY;
  delete process.env.SMTP_USER;

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/platform', require('../src/platform/routes'));
  app.use((err, req, res, _next) => res.status(err.status || 500).json({ error: err.message }));

  const server = app.listen(0);
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/api/platform/signup`;

  const post = async (body) => {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  const client = await MongoClient.connect(base);
  const signups = client.db('gf_control').collection('signups');

  const valid = {
    gan: 'גן שלהבת', name: 'רונית לוי', phone: '052-123-4567',
    email: 'Ronit@Example.COM', children: '38', branches: '1',
    note: 'יש לנו שעון TIMEDOX',
  };

  console.log('\n📋 טופס ההרשמה באתר\n');

  // ---------------------------------------------------------------- the happy one
  let r = await post(valid);
  ok(r.status === 200 && r.body.ok === true, 'פנייה תקינה מתקבלת');

  let doc = await signups.findOne({ gan_name: 'גן שלהבת' });
  ok(!!doc, 'הפנייה נשמרה במסד הבקרה');
  ok(doc && doc.phone === '0521234567', 'טלפון עם מקפים נשמר מנורמל');
  ok(doc && doc.email === 'ronit@example.com', 'אימייל נשמר באותיות קטנות');
  ok(doc && doc.children === 38, 'מספר הילדים נשמר כמספר');
  ok(doc && doc.status === 'new', 'הסטטוס ההתחלתי הוא "חדש"');

  // ------------------------------------------------- the email failed, the lead did not
  // The notification is fired after the response, so give it a moment to lose.
  for (let i = 0; i < 40 && !(doc && doc.notify_error); i++) {
    await sleep(50);
    doc = await signups.findOne({ gan_name: 'גן שלהבת' });
  }
  ok(doc && !!doc.notify_error, 'כשההתראה במייל נכשלת — הפנייה עדיין שמורה, והכישלון רשום עליה');
  ok(doc && !doc.notified_at, 'ולא מסומן שנשלחה התראה');

  // ---------------------------------------------------------------- the honeypot
  r = await post({ ...valid, gan: 'בוט', phone: '0500000000', website: 'http://spam.example' });
  ok(r.status === 200, 'מילוי שדה המלכודת מוחזר כהצלחה (כדי שהבוט לא ינסה שוב)');
  ok(!(await signups.findOne({ gan_name: 'בוט' })), 'ולא נשמר כלום');

  // ---------------------------------------------------------------- validation
  r = await post({ ...valid, phone: '12345' });
  ok(r.status === 400 && /טלפון/.test(r.body.error || ''), 'טלפון לא תקין נדחה, וההודעה אומרת איזה שדה');

  r = await post({ ...valid, phone: '0541111111', email: 'not-an-email' });
  ok(r.status === 400 && /אימייל/.test(r.body.error || ''), 'אימייל לא תקין נדחה');

  r = await post({ ...valid, gan: '', phone: '0542222222' });
  ok(r.status === 400 && /שם הגן/.test(r.body.error || ''), 'שם גן חסר נדחה');

  // ---------------------------------------------------------------- pressed twice
  await post({ ...valid, name: 'רונית לוי-כהן' });
  const same = await signups.find({ phone: '0521234567' }).toArray();
  ok(same.length === 1, 'שליחה שנייה מאותו טלפון לא יוצרת פנייה כפולה');
  ok(same[0] && same[0].full_name === 'רונית לוי-כהן', 'והשליחה האחרונה היא זו שנשמרת');

  // ---------------------------------------------------------------- the ceiling
  let hit429 = false;
  for (let i = 0; i < 12 && !hit429; i++) {
    const res = await post({ ...valid, phone: `05310000${String(i).padStart(2, '0')}` });
    if (res.status === 429) hit429 = true;
  }
  ok(hit429, 'הצפה מאותה כתובת נעצרת ב-429');

  await client.close();
  server.close();
  await require('../src/platform/connection').closeAll();
  await mongo.stop();

  console.log(failures ? `\n❌ ${failures} בדיקות נכשלו\n` : '\n✅ הכול עבר\n');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
