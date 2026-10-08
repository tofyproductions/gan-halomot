#!/usr/bin/env node
/**
 * ריענוני קורסים — התזכורת מגיעה קודם למנהל/ת המעון, והדוח למשרד.
 *
 * What must hold:
 *
 *   each branch's manager gets ONLY her own caregivers' refreshers —
 *     הרצליה's list never lands in כפר סבא's inbox;
 *   an admin_viewer covering a branch counts as its manager (תל אביב);
 *   a manager whose account has only a login handle (…@gan-halomot.local)
 *     cannot be mailed — her branch's reminder falls back to the office with
 *     a notice saying who it was meant for, and is never silently dropped;
 *   the consolidated office report still carries every branch, and its
 *     recipients include the compliance_alert_emails setting (עינת) and the
 *     system admins;
 *   far-future, archived and inactive-employee courses stay out of everything.
 *
 *   node scripts/course-refresher-reminders.test.js
 */
try { require.resolve('mongodb-memory-server'); } catch {
  console.error('\n❌  npm install --no-save mongodb-memory-server\n'); process.exit(1);
}
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = { id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) } };
const { MongoMemoryServer } = require('mongodb-memory-server');

let failures = 0;
const ok = (c, l, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${l}${!c && d ? `  (${d})` : ''}`); if (!c) failures++; };
const eq = (a, b, l) => ok(JSON.stringify(a) === JSON.stringify(b), l, `קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)}`);

(async () => {
  const mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri() + 'gan_test';
  process.env.JWT_SECRET = 'refresher-test';
  delete process.env.PLATFORM_MONGODB_URI;
  const mongoose = require('mongoose');
  await mongoose.connect(process.env.MONGODB_URI);
  const { Branch, Employee, EmployeeCourse, User, Setting } = require('../src/models');
  const digest = require('../src/services/complianceDigestJob');

  const NOW = new Date();
  const days = (n) => new Date(NOW.getTime() + n * 86400000);
  const idn = (() => { let n = 100000000; return () => String(n++); })();

  const herzliya = await Branch.create({ name: 'הרצליה הרצוג' });
  const ks = await Branch.create({ name: 'כפר סבא - משה דיין' });
  const tlv = await Branch.create({ name: 'תל אביב - יפו' });

  // The managers. אלעד covers תל אביב as admin_viewer; רבקה has only a login
  // handle, so her branch's mail must fall back to the office.
  const mkUser = (over) => User.create({
    full_name: over.full_name, email: over.email, password_hash: 'x',
    role: over.role, managed_branch_ids: over.managed || [], branch_id: over.branch || null,
    is_active: true,
  });
  await mkUser({ full_name: 'טובה', email: 'tova@example.com', role: 'branch_manager', managed: [herzliya._id] });
  await mkUser({ full_name: 'לידור', email: 'lidor@example.com', role: 'branch_manager', managed: [ks._id] });
  await mkUser({ full_name: 'אלעד', email: 'elad@example.com', role: 'admin_viewer', managed: [tlv._id] });
  await mkUser({ full_name: 'אדמין', email: 'admin@example.com', role: 'system_admin' });
  await Setting.create({ key: 'compliance_alert_emails', value: ['einat@example.com'] });

  const mkEmp = (name, branch, extra = {}) => Employee.create({
    full_name: name, israeli_id: idn(), branch_id: branch._id, is_active: true, ...extra,
  });
  const course = (emp, type, expires, extra = {}) => EmployeeCourse.create({
    employee_id: emp._id, course_type: type, expires_at: expires, ...extra,
  });

  const dana = await mkEmp('דנה', herzliya);
  const noa = await mkEmp('נועה', herzliya);
  const shir = await mkEmp('שיר', ks);
  const maya = await mkEmp('מאיה', tlv);
  const gone = await mkEmp('עזבה', herzliya, { is_active: false });

  await course(dana, 'first_aid', days(-5));          // expired
  await course(noa, 'safe_conduct', days(20));        // expiring
  await course(shir, 'first_aid', days(10));          // expiring
  await course(maya, 'first_aid', days(-1));          // expired
  await course(dana, 'safe_conduct', days(300));      // fine — out
  await course(noa, 'first_aid', days(-9), { is_archived: true }); // archived — out
  await course(gone, 'first_aid', days(-9));          // inactive employee — out

  console.log('\n📬 תזכורת לכל מנהל/ת — רק הסניף שלה\n');

  let r = await digest.send({ dryRun: true });
  ok(r.sent, 'הדוח נשלח (dry run)');
  const byBranch = Object.fromEntries((r.branch_mails || []).map(b => [b.branch, b]));

  eq(byBranch['הרצליה הרצוג']?.to, ['tova@example.com'], 'הרצליה → טובה');
  eq(byBranch['הרצליה הרצוג']?.count, 2, 'עם שתי העובדות שלה בלבד');
  eq(byBranch['כפר סבא - משה דיין']?.to, ['lidor@example.com'], 'כפר סבא → לידור');
  eq(byBranch['כפר סבא - משה דיין']?.count, 1, 'עובדת אחת');
  eq(byBranch['תל אביב - יפו']?.to, ['elad@example.com'], 'תל אביב → אלעד (admin_viewer שמכסה את הסניף)');
  ok(!byBranch['תל אביב - יפו']?.fell_back, 'בלי נפילה למשרד — יש לו כתובת');

  console.log('\n📋 הדוח המרוכז למשרד\n');

  ok(r.to.includes('einat@example.com'), 'עינת (compliance_alert_emails) מקבלת את הדוח');
  ok(r.to.includes('admin@example.com'), 'וגם מנהל המערכת');
  // r.total also counts the branches' missing-certificate gaps; the course
  // list itself is what this feature filters, so count it directly.
  const collected = await digest.collect(NOW);
  eq(collected.dueCourses.length, 4, 'הדוח סופר את כל 4 הריענונים — בלי ארכיון, בלי עתיד רחוק, בלי מי שעזבה');

  console.log('\n🪂 מנהלת בלי כתובת אמיתית — נופל למשרד עם הסבר\n');

  await User.updateOne({ email: 'tova@example.com' }, { $set: { email: '123456789@gan-halomot.local' } });
  r = await digest.send({ dryRun: true });
  const hz = (r.branch_mails || []).find(b => b.branch === 'הרצליה הרצוג');
  ok(hz?.fell_back, 'התזכורת של הרצליה נפלה למשרד');
  ok(hz?.to.includes('admin@example.com'), 'והגיעה למנהל המערכת במקום להיעלם');

  await mongoose.disconnect();
  await mongo.stop();
  console.log(failures ? `\n❌ ${failures} בדיקות נכשלו\n` : '\n✅ כל הבדיקות עברו\n');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
