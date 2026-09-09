#!/usr/bin/env node
/**
 * שתי התראות ההצלבה — התזכורת החודשית לעינת (SMS + מייל) והדיגסט היומי
 * (שכבת גיל שונה, מייל).
 *
 * לא מרים שרת HTTP — שתי המשימות הן פונקציות טהורות מעל מסד נתונים, בלי
 * נתיב אחד שדורש אימות. sms.service ו-email.service מוחלפים ב-require.cache
 * לפני שהמשימות נטענות, באותה שיטה שה-dotenv מוחלף בה בבדיקות האחרות בקובץ
 * הזה — כדי שהבדיקה לעולם לא תשלח הודעה אמיתית.
 *
 *   node scripts/reconcile-alerts.test.js
 */

/* ------------------------------------------------------------------ *
 * 1. Nothing may read server/.env, and nothing may call a real provider.
 * ------------------------------------------------------------------ */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};

const sentSms = [];
const smsPath = require.resolve('../src/services/sms.service');
require.cache[smsPath] = {
  id: smsPath, filename: smsPath, loaded: true, children: [], paths: [],
  exports: {
    sendSms: async ({ to, text }) => { sentSms.push({ to, text }); return { to, status: 1 }; },
    normalizePhone: (v) => v, isConfigured: () => true,
  },
};

const sentEmails = [];
const emailPath = require.resolve('../src/services/email.service');
require.cache[emailPath] = {
  id: emailPath, filename: emailPath, loaded: true, children: [], paths: [],
  exports: {
    dispatchEmail: async (opts) => { sentEmails.push(opts); return { ok: true }; },
    sendAgreementEmail: async () => ({}), sendRegistrationLink: async () => ({}),
    sendOrderEmail: async () => ({}), buildOrderHTML: () => '',
  },
};

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let failures = 0;
let checks = 0;
function ok(cond, label, detail = '') {
  checks++;
  if (cond) console.log(`  ✅ ${label}`);
  else { failures++; console.log(`  ❌ ${label}${detail ? `  (${detail})` : ''}`); }
  return !!cond;
}
const eq = (actual, expected, label) => ok(
  JSON.stringify(actual) === JSON.stringify(expected), label,
  `קיבלנו ${JSON.stringify(actual)}, ציפינו ${JSON.stringify(expected)}`,
);
const head = (t) => console.log(`\n${t}`);

async function main() {
  console.log('=== התראות ההצלבה: תזכורת חודשית + דיגסט יומי ===');

  process.env.JWT_SECRET = 'reconcile-alerts-secret';
  process.env.PARENT_SECRET = 'reconcile-alerts-parent-secret';
  process.env.DISABLE_JOBS = '1';
  process.env.NODE_ENV = 'development';
  delete process.env.PLATFORM_MONGODB_URI;

  const mongod = await MongoMemoryServer.create({ instance: { dbName: 'gan_reconcile_alerts' } });
  process.env.MONGODB_URI = mongod.getUri();
  await mongoose.connect(process.env.MONGODB_URI);

  const {
    Branch, User, EnrollmentImport, Setting, ExternalEnrollment, TmtApproval, ReconcileDecision,
  } = require('../src/models');
  await Promise.all([
    ExternalEnrollment.syncIndexes(), TmtApproval.syncIndexes(),
    EnrollmentImport.syncIndexes(), Branch.syncIndexes(), User.syncIndexes(),
  ]);

  const herzliya = await Branch.create({ name: 'הרצליה הרצוג' });
  const kfarSabaA = await Branch.create({ name: 'כפר סבא - משה דיין' });
  const kaplan = await Branch.create({ name: 'כפר סבא - קפלן' }); // never asked — not TMT-supervised
  const tlv = await Branch.create({ name: 'תל אביב', is_active: false }); // inactive — never asked

  const YEAR = '2026-2027';
  const now = new Date();
  const daysAgo = (n) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);

  await EnrollmentImport.create({
    source: 'clicktac', export_type: 'registrations', branch_id: herzliya._id, academic_year: YEAR,
    created_at: daysAgo(5), rows: 1, parsed: 1,
  });
  await EnrollmentImport.create({
    source: 'clicktac', export_type: 'contracts', branch_id: kfarSabaA._id, academic_year: YEAR,
    created_at: daysAgo(60), rows: 1, parsed: 1,
  });
  // No import at all for קפלן or תל אביב — irrelevant, both excluded upstream.

  await User.create({
    email: 'einat@ct.local', full_name: 'עינת רוה', id_number: '900000010',
    role: 'teacher', branch_id: herzliya._id, position: 'רכזת רישום',
    password_hash: 'x', password_set: true, is_active: true, phone: '0545545472',
  });

  head('בדיקה 1 — התזכורת החודשית: מי צריך קובץ');
  {
    const reminder = require('../src/services/reconcileUploadReminderJob');
    const needing = await reminder.branchesNeedingUpload(now);
    ok(!needing.includes('הרצליה הרצוג'), '1a הרצליה עלתה לפני 5 ימים — לא ברשימה', JSON.stringify(needing));
    ok(needing.includes('כפר סבא - משה דיין'), '1b כפר סבא עלה לפני 60 יום — ברשימה', JSON.stringify(needing));
    ok(!needing.includes('כפר סבא - קפלן'), '1c קפלן אינו תחת התמ"ת — לעולם לא מבוקש');
    ok(!needing.includes('תל אביב'), '1d סניף לא פעיל — לא מבוקש');

    const text = reminder.messageText(needing);
    ok(text.includes('כפר סבא - משה דיין'), '1e ה-SMS מזכיר את שם הסניף החסר', text);
    ok(!text.includes('הרצליה הרצוג'), '1f ולא את הסניף המעודכן', text);

    const textEmpty = reminder.messageText([]);
    ok(/מעודכנים/.test(textEmpty), '1g בלי חוסרים — הודעה חיובית, לא רשימה ריקה', textEmpty);
  }

  head('בדיקה 2 — התזכורת החודשית: שליחה בפועל, וכל ערוץ עם המנעול החודשי שלו');
  {
    const reminder = require('../src/services/reconcileUploadReminderJob');
    sentSms.length = 0; sentEmails.length = 0;

    // בלי הגדרת reconcile_alert_emails — אין נמען למייל, ה-SMS כן יוצא.
    const r1 = await reminder.send({ now });
    eq(r1.sms?.ok, true, '2a ה-SMS נשלח בהצלחה');
    ok(sentSms.length === 1 && sentSms[0].to === '0545545472', '2b ה-SMS נשלח לטלפון של עינת', JSON.stringify(sentSms));
    ok(sentSms[0].text.includes('כפר סבא - משה דיין'), '2c ותוכנו מזכיר את הסניף החסר');
    eq(r1.email?.ok, false, '2d אין הגדרת מייל — לא נשלח');
    eq(sentEmails.length, 0, '2e ואף מייל לא יצא בפועל');

    /**
     * המנעול החודשי הוא לכל ערוץ בנפרד. קריאה חוזרת בלי force לא שולחת שוב
     * SMS שכבר יצא החודש — גם אם המייל עדיין ממתין להגדרה. זה בדיוק המצב
     * שקרה בפועל: SMS יצא עם פרטי ההתחברות האמיתיים, המייל נכשל כי ספק
     * המייל קיים רק ב-Render ולא בסביבה המקומית.
     */
    sentSms.length = 0;
    const r1b = await reminder.send({ now });
    eq(r1b.sms?.skipped, 'already sent this month', '2f בלי force — ה-SMS לא נשלח שוב החודש');
    eq(sentSms.length, 0, '2g ובאמת לא יצא כלום');

    await Setting.create({ key: reminder.RECIPIENTS_KEY, value: ['einat.real@example.com'] });
    sentSms.length = 0; sentEmails.length = 0;
    // force — כמו טריגר ידני: שולח בכל ערוץ, גם אם כבר נשלח החודש.
    const r2 = await reminder.send({ now, force: true });
    eq(r2.email?.ok, true, '2h עכשיו יש הגדרה — המייל נשלח');
    eq(sentEmails.length, 1, '2i מייל אחד יצא');
    eq(sentEmails[0].to, ['einat.real@example.com'], '2j לכתובת שהוגדרה');
    ok(sentSms.length === 1, '2k וה-SMS נשלח שוב כי force ביקש זאת מפורשות');

    // בלי משתמשת בשם "עינת רוה" — אין טלפון, ה-SMS נכשל בבירור, בלי לזרוק.
    await User.updateOne({ full_name: 'עינת רוה' }, { $set: { is_active: false } });
    sentSms.length = 0;
    const r3 = await reminder.send({ now, force: true });
    eq(r3.sms?.ok, false, '2l בלי משתמשת פעילה — ה-SMS מדווח כשל ברור');
    ok(/עינת רוה/.test(r3.sms?.error || ''), '2m וההודעה אומרת את מי לא מצאנו', r3.sms?.error);
    eq(sentSms.length, 0, '2n ולא נשלח כלום בפועל');
    await User.updateOne({ full_name: 'עינת רוה' }, { $set: { is_active: true } });
    await Setting.deleteMany({ key: reminder.RECIPIENTS_KEY });
    await Setting.deleteMany({ key: /reconcile_upload_reminder_.*_last_sent/ });
  }

  head('בדיקה 3 — הדיגסט היומי: שכבת גיל שונה בלבד, פר סניף, בלי כפילויות');
  {
    const digest = require('../src/services/reconcileDigestJob');
    const kidBase = {
      id_number: '245455459', full_name: 'רון כרמל', birth_date: new Date('2025-06-01'),
    };
    await TmtApproval.create({
      source: 'tmt', source_file: 'x.xls', branch_id: herzliya._id, academic_year: YEAR,
      child: { ...kidBase, age_group: 'פעוט', source_age_group: 'פעוטות' },
      contact: { name: 'הורה', phone: '0501112233', email: '' },
      ministry: { decision: 'התקבל', is_approved: true, absorbed_at: new Date() },
      presence: { is_present: true, first_seen_at: now, last_seen_at: now, missing_since: null },
      content_hash: `t-${kidBase.id_number}`,
    });
    await ExternalEnrollment.create({
      source: 'clicktac', branch_id: herzliya._id, academic_year: YEAR,
      child: { ...kidBase, age_group: 'בוגר' },
      parent1: { first_name: 'הורה', last_name: 'כרמל', phone: '0501112233' },
      enrollment: { status: 'התקבל' },
      sources: ['registrations'],
      presence: { is_present: true, first_seen_at: now, last_seen_at: now, missing_since: null },
      content_hash: `c-${kidBase.id_number}`,
    });

    const data = await digest.collect();
    const row = data.rows.find(r => r.id_number === kidBase.id_number);
    ok(!!row, '3a הילד עם שכבת הגיל השונה נמצא', JSON.stringify(data.rows.map(r => r.id_number)));
    eq(row?.branch, 'הרצליה הרצוג', '3b עם שם הסניף הנכון');
    ok(/פעוט/.test(row?.detail || '') && /בוגר/.test(row?.detail || ''), '3c ופירוט שתי השכבות', row?.detail);
    ok(!data.rows.some(r => r.branch === 'כפר סבא - קפלן' || r.branch === 'תל אביב'),
      '3d קפלן וסניף לא פעיל לא נבדקים בכלל');

    const h1 = digest.hashOf(data);
    const h2 = digest.hashOf(await digest.collect());
    eq(h1, h2, '3e ה-hash יציב בין שתי קריאות זהות');
  }

  head('בדיקה 4 — הדיגסט היומי: חריגה שנסגרה על ידי אדם אינה נחשבת עוד דחופה');
  {
    const digest = require('../src/services/reconcileDigestJob');
    const before = await digest.collect();
    ok(before.rows.length > 0, '4a לפני הסגירה — יש שורה דחופה');

    await ReconcileDecision.create({
      branch_id: herzliya._id, academic_year: YEAR, id_number: '245455459',
      resolutions: [{
        code: 'age_group_mismatch', choice: 'ok',
        snapshot: { tmt: 'פעוט', ct: 'בוגר' }, at: new Date(),
      }],
    });
    const after = await digest.collect();
    eq(after.rows.length, 0, '4b אחרי הסגירה — אין אף שורה דחופה');
  }

  head('בדיקה 5 — הדיגסט היומי: שליחה ונמענים');
  {
    const digest = require('../src/services/reconcileDigestJob');
    await ReconcileDecision.deleteMany({});
    sentEmails.length = 0;

    const empty = await digest.send();
    eq(empty.sent, false, '5a בלי חריגות פתוחות — לא נשלח כלום');
    eq(sentEmails.length, 0, '5b ובאמת לא יצא מייל');

    await User.create({
      email: 'admin@ct.local', full_name: 'מנהל מערכת', id_number: '900000020',
      role: 'system_admin', branch_id: herzliya._id, position: 'מנהל',
      password_hash: 'x', password_set: true, is_active: true,
    });
    await Setting.create({ key: digest.RECIPIENTS_KEY, value: ['einat.real@example.com'] });

    const r = await digest.send();
    eq(r.sent, true, '5c עם משתמש אדמין וההגדרה — נשלח');
    eq(sentEmails.length, 1, '5d מייל אחד בפועל');
    const to = new Set(sentEmails[0].to);
    ok(to.has('einat.real@example.com') && to.has('admin@ct.local'), '5e לשניהם — עינת ומנהל המערכת', JSON.stringify([...to]));
    ok(/שכבת גיל שונה/.test(sentEmails[0].subject), '5f הכותרת אומרת על מה מדובר', sentEmails[0].subject);
  }

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} בדיקות עברו`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('\n💥', err); process.exit(1); });
