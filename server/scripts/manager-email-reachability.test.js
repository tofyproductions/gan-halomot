#!/usr/bin/env node
/**
 * A branch manager's notifications reach a person, or reach the office — never
 * a mailbox that does not exist.
 *
 * WHAT WENT WRONG. Every caller that mails a branch's managers wrote
 * `managers.map(m => m.email).filter(Boolean)`, and `filter(Boolean)` asks
 * whether a string is there, not whether a mailbox is. Most logins in this
 * system carry a synthetic handle built from the ת"ז —
 * `<ת"ז>@gan-halomot.local` (services/userSync.js) — which is a correct LOGIN
 * and is not an address: `.local` resolves nowhere, so the send fails and
 * bounces.
 *
 * Found in production on 30.09.2026 with two live managers in exactly that
 * state, between them covering three of the four branches. Everything aimed at
 * them had been failing: punch reminders, candidates, leads, payslips,
 * contracts, letters, onboarding.
 *
 * WHAT IS PINNED HERE.
 *
 *   1. isRealEmail is the one definition, and it rejects both dead shapes —
 *      the `.local` handle and `ganhalomot.co.il`, a domain nobody registered.
 *   2. mailableManagerEmails drops an unreachable manager and KEEPS the
 *      reachable ones. A branch with one real manager and one placeholder still
 *      mails the real one, and says nothing extra.
 *   3. When NOBODY on a branch is reachable it falls back to the office and
 *      returns a notice naming who the message was for. Silence is the failure
 *      this codebase refuses; a bounce is not an improvement on it.
 *   4. The notice is empty whenever the message reached a real manager, so an
 *      ordinary send carries no red box.
 *
 *   npm install --no-save mongodb-memory-server
 *   node scripts/manager-email-reachability.test.js
 */
try { require.resolve('mongodb-memory-server'); } catch {
  console.error('\n❌  חסרה חבילת הבדיקה. הרץ:\n\n   npm install --no-save mongodb-memory-server\n');
  process.exit(1);
}

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const { ObjectId } = mongoose.Types;

let failures = 0;
const ok = (cond, label) => { console.log(`  ${cond ? '✅' : '❌'} ${label}`); if (!cond) failures++; };
const eq = (a, b, label) => {
  const good = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  ${good ? '✅' : '❌'} ${label}${good ? '' : `  (קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)})`}`);
  if (!good) failures++;
};

(async () => {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri('gan_reach_test'), { dbName: 'gan_reach_test' });
  const db = mongoose.connection.db;

  const { isRealEmail } = require('../src/services/office-recipients.service');
  const { mailableManagerEmails } = require('../src/services/branch-recipients.service');

  console.log('\n📮  מה נחשב כתובת שאפשר להגיע אליה\n');
  {
    ok(!isRealEmail('015376965@gan-halomot.local'), 'ידית התחברות מת"ז — לא כתובת');
    ok(!isRealEmail('admin@ganhalomot.co.il'), 'הדומיין הישן שלא נרשם מעולם — לא כתובת');
    ok(!isRealEmail(''), 'ריק — לא כתובת');
    ok(!isRealEmail(null), 'null — לא כתובת');
    ok(!isRealEmail('לא-מייל'), 'מחרוזת שאינה מייל — לא כתובת');
    ok(isRealEmail('tanya@dreamgan.com'), 'כתובת dreamgan.com — כן');
    ok(isRealEmail('Someone@Gmail.com'), 'גם באותיות גדולות');
    // The bug in one line: the old test was truthiness.
    ok(Boolean('015376965@gan-halomot.local') === true,
      'ולהמחשה: filter(Boolean) היה מקבל את הידית — זה היה הבאג');
  }

  // Two live system admins, so the office fallback has somewhere to land.
  const adminA = new ObjectId(); const adminB = new ObjectId();
  await db.collection('users').insertMany([
    { _id: adminA, full_name: 'בן כהן', email: 'ben@example.com', role: 'system_admin', is_active: true },
    { _id: adminB, full_name: 'עמית קוחטה', email: 'amit@example.com', role: 'system_admin', is_active: true },
  ]);

  console.log('\n👤  מנהלת עם כתובת אמיתית\n');
  {
    const r = await mailableManagerEmails(
      [{ full_name: 'אורלי מור', email: 'orly@dreamgan.com' }],
      { what: 'תזכורת', branchName: 'תל אביב - יפו' },
    );
    eq(r.to, ['orly@dreamgan.com'], 'המייל הולך אליה');
    eq(r.fell_back, false, 'ולא נופל למשרד');
    eq(r.notice, '', 'ובלי שום הודעה אדומה בגוף');
  }

  console.log('\n👥  אחת אמיתית, אחת עם ידית בלבד\n');
  {
    const r = await mailableManagerEmails([
      { full_name: 'אורלי מור', email: 'orly@dreamgan.com' },
      { full_name: 'טניה אהרון', email: '015376965@gan-halomot.local' },
    ], { what: 'תזכורת', branchName: 'הרצליה הרצוג' });
    eq(r.to, ['orly@dreamgan.com'], 'נשלח רק למי שאפשר להגיע אליה');
    eq(r.fell_back, false, 'בלי נפילה למשרד — יש למי לשלוח');
    eq(r.notice, '', 'ובלי הודעה אדומה, כי ההודעה הגיעה למנהלת');
    eq(r.unreachable.map(u => u.name), ['טניה אהרון'], 'ומי שאין לה כתובת מדווחת');
  }

  console.log('\n🏢  אף אחת לא נגישה — ההודעה עוברת למשרד\n');
  {
    const r = await mailableManagerEmails(
      [{ full_name: 'לידור כהן', email: '313163412@gan-halomot.local' }],
      { what: 'תזכורת השלמת החתמות', branchName: 'כפר סבא - משה דיין' },
    );
    eq(r.to.sort(), ['amit@example.com', 'ben@example.com'], 'הולך למנהלי המערכת');
    eq(r.fell_back, true, 'ומסומן כנפילה');
    ok(r.notice.includes('לידור כהן'), 'וההודעה אומרת למי זה היה אמור ללכת');
    ok(r.notice.includes('כפר סבא - משה דיין'), 'ומאיזה סניף');
    ok(r.notice.includes('תזכורת השלמת החתמות'), 'ומה זה היה');
    ok(/מסך העובדים/.test(r.notice), 'ואיך מתקנים');
  }

  console.log('\n🚫  בלי מנהלות בכלל\n');
  {
    const r = await mailableManagerEmails([], { what: 'דוח', branchName: 'סניף ריק' });
    eq(r.to.sort(), ['amit@example.com', 'ben@example.com'], 'גם אז המשרד מקבל — שום דבר לא נעלם');
    eq(r.fell_back, true, 'ומסומן כנפילה');
  }

  console.log('\n🧹  אין כפילויות\n');
  {
    const r = await mailableManagerEmails([
      { full_name: 'א', email: 'same@dreamgan.com' },
      { full_name: 'ב', email: 'same@dreamgan.com' },
    ], {});
    eq(r.to, ['same@dreamgan.com'], 'אותה כתובת פעמיים נשלחת פעם אחת');
  }

  console.log('\n🔍  אף קורא לא נשאר עם filter(Boolean)\n');
  {
    // The regression guard: the shape of the bug, not one instance of it. A new
    // controller that copies the old line is caught here rather than in
    // production, three weeks later, by a manager who never got her payslips.
    const { execSync } = require('child_process');
    let hits = '';
    try {
      const raw = execSync(
        String.raw`grep -rn "\.map(m => m\.email)\.filter(Boolean)\|m\.email && " src/controllers src/services || true`,
        { cwd: `${__dirname}/..`, encoding: 'utf8' },
      );
      // Comments are allowed to quote the bug — this file's own explanation of
      // it does, and so does the service's. Only live code counts.
      hits = raw.split('\n')
        .filter(Boolean)
        .filter(line => !/^[^:]+:\d+:\s*(\*|\/\/|\/\*)/.test(line))
        .join('\n')
        .trim();
    } catch { /* grep found nothing */ }
    ok(hits === '', `אין קורא שמסנן ב-Boolean${hits ? `:\n${hits}` : ''}`);
  }

  console.log(failures ? `\n❌  ${failures} כשלונות\n` : '\n✅  הכל עבר\n');
  await mongoose.disconnect();
  await mongo.stop();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('\n❌  נפילה:', e.message, '\n', e.stack); process.exit(1); });
