#!/usr/bin/env node
/**
 * READING THE CERTIFICATES OUT OF DRIVE — the guessing, and the refusals.
 *
 * Four years of filenames typed by hand are the input, so the question is not
 * "does it parse the happy one" but what it does with the rest. The expensive
 * mistake is specific and quiet: a certificate attached to the WRONG BRANCH is
 * a branch that looks covered and is not, and nobody finds out until an
 * inspector asks.
 *
 * The gan has four branches and the Drive has three folders, because כפר סבא
 * names two of them — קפלן and משה דיין — and no filename says which. So the
 * thing worth proving is that those come back UNRESOLVED and are refused on
 * import, rather than landing on whichever branch sorted first.
 *
 * Also pinned here: the date formats actually in use ("מבדק בתאריך 13/03/26",
 * "תברואן 7.26"), that "בודק בטיחות" is not eaten by a rule for "בטיחות" and
 * "התנהלות בטוחה" is not read as a safety inspection at all, that a file
 * sitting in two folders is one proposal and not two, and that importing the
 * same file twice does not give a branch two expiry dates to disagree about.
 *
 *   node scripts/drive-certs.test.js
 */
try { require.resolve('mongodb-memory-server'); } catch {
  console.error('\n❌  חסרה חבילת הבדיקה. הרץ:\n\n   npm install --no-save mongodb-memory-server\n');
  process.exit(1);
}

const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};

const { MongoMemoryServer } = require('mongodb-memory-server');

let failures = 0;
const ok = (c, label, detail = '') => {
  console.log(`  ${c ? '✅' : '❌'} ${label}${!c && detail ? `  (${detail})` : ''}`);
  if (!c) failures++;
  return !!c;
};
const eq = (a, b, label) => ok(a === b, label, `קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)}`);

(async () => {
  const mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri() + 'gan_test';
  process.env.JWT_SECRET = 'drive-certs-test';
  delete process.env.PLATFORM_MONGODB_URI;
  delete process.env.GOOGLE_SHEETS_CREDENTIALS;

  const mongoose = require('mongoose');
  const jwt = require('jsonwebtoken');
  await mongoose.connect(process.env.MONGODB_URI);

  const { Branch, BranchCertification } = require('../src/models');
  const drive = require('../src/services/driveCerts.service');

  console.log('\n📁 ייבוא אישורים מהדרייב\n');

  // ------------------------------------------------------- the classifier
  console.log('מה הקובץ הזה');
  const f = (name, trail = []) => drive.classify({ id: 'x', name, trail });

  let p = f('הרצליה-דוח התאמת תשתית לייעודה- מבדק בתאריך 13/03/26.pdf');
  eq(p.type, 'infrastructure', 'דוח התאמת תשתית');
  eq(p.branch_word, 'הרצליה', 'והסניף מתוך שם הקובץ');
  eq(p.issued_at, '2026-03-13', 'ותאריך מתוך "מבדק בתאריך 13/03/26"');
  eq(p.confidence, 'high', 'ביטחון גבוה');

  p = f('הרצלייה אישור תברואן 7.26.pdf');
  eq(p.type, 'sanitarian', 'תברואן');
  eq(p.issued_at, '2026-07-01', '"7.26" נקרא כתחילת יולי 2026');
  eq(p.date_precision, 'month', 'ומסומן כדיוק של חודש — לא המצאנו יום');
  eq(p.branch_word, 'הרצליה', 'וגם "הרצלייה" בשני יו"דים מזוהה');

  p = f('תל אביב יפו אייזיק חריף אישור תזונאית עם הרישיון.pdf');
  eq(p.type, 'nutritionist', 'תזונאית — ולא "רישיון הפעלה" מהמילה "הרישיון"');
  eq(p.branch_word, 'תל אביב', 'יפו/אייזיק חריף → תל אביב');
  eq(p.issued_at, null, 'בלי תאריך בשם — נשאר ריק ולא מומצא');

  p = f('סניף כפר סבא', ['בדיקות תקופתיות של מתקני הגז ב3 המעונות']);
  eq(p.type, 'gas_inspection', 'הסוג מגיע מהתיקייה כשהקובץ לא אומר אותו');
  eq(p.needs_branch, true, 'וכפר סבא חייב שאלה — שני סניפים נושאים את השם');
  eq(p.branch_word, null, 'ולכן לא נבחר סניף');

  // ------------------------------------------- rules that must not collide
  console.log('\nכללים שלא מתנגשים');
  eq(f('אישור בודק בטיחות 2026.pdf').type, 'safety_inspector', 'בודק בטיחות');
  const sc = f('תעודת התנהלות בטוחה - רונית.pdf');
  eq(sc.kind, 'course', 'התנהלות בטוחה היא תעודה של עובדת');
  eq(sc.type, 'safe_conduct', 'ולא בדיקת בטיחות של הבניין');
  eq(f('עזרה ראשונה מד"א - שירה.pdf').type, 'first_aid', 'עזרה ראשונה');
  eq(f('טופס הסכמה מרשם פלילי.pdf').type, 'criminal_registry', 'מרשם פלילי');
  eq(f('משהו שאין לו שם מזהה.pdf').type, null, 'מה שלא מזוהה חוזר ריק');
  eq(f('משהו שאין לו שם מזהה.pdf').confidence, 'low', 'ובביטחון נמוך');

  // -------------------------------------------------------- dates on their own
  console.log('\nתאריכים');
  eq(drive.parseDate('מבדק בתאריך 09/02/26').date.toISOString().slice(0, 10), '2026-02-09', 'DD/MM/YY');
  eq(drive.parseDate('6.26').date.toISOString().slice(0, 10), '2026-06-01', 'M.YY');
  eq(drive.parseDate('13/03/2026').date.toISOString().slice(0, 10), '2026-03-13', 'DD/MM/YYYY');
  eq(drive.parseDate('אין כאן תאריך'), null, 'ובלי תאריך — null');
  eq(drive.parseDate('99/99/26'), null, 'חודש לא חוקי נדחה');

  // ------------------------------------------------------- the import refuses
  console.log('\nהייבוא מסרב ולא מנחש');
  const ks = await Branch.create({ name: 'כפר סבא - משה דיין' });
  const hz = await Branch.create({ name: 'הרצליה הרצוג' });

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = jwt.verify(String(req.headers.authorization || '').replace('Bearer ', ''), process.env.JWT_SECRET);
    next();
  });
  app.use('/api/branch-certifications', require('../src/routes/branchCertifications.routes'));
  app.use((err, req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/branch-certifications`;
  const admin = jwt.sign({ id: String(new mongoose.Types.ObjectId()), role: 'system_admin' },
    process.env.JWT_SECRET, { expiresIn: '1h' });
  const post = async (path, body) => {
    const r = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin}` },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  const URL1 = 'https://drive.google.com/file/d/AAA/view';
  const r1 = await post('/drive/import', { items: [
    { file_name: 'תברואן הרצליה', url: URL1, kind: 'cert', type: 'sanitarian', branch_id: String(hz._id), issued_at: '2026-07-01' },
    { file_name: 'כפר סבא בלי סניף', url: 'https://drive.google.com/file/d/BBB/view', kind: 'cert', type: 'sanitarian', branch_id: null },
    { file_name: 'בלי סוג', url: 'https://drive.google.com/file/d/CCC/view', kind: 'cert', type: null, branch_id: String(hz._id) },
    { file_name: 'תעודה של עובדת', url: 'https://drive.google.com/file/d/DDD/view', kind: 'course', type: 'first_aid', branch_id: String(hz._id) },
  ] });
  eq(r1.status, 201, 'הבקשה נענית');
  eq(r1.body.created, 1, 'רק אחד נכנס');
  eq(r1.body.refused.length, 3, 'ושלושה נדחו');
  const reasons = r1.body.refused.map(x => x.reason);
  ok(reasons.some(x => /סניף/.test(x)), 'כפר סבא נדחה כי לא נבחר סניף', JSON.stringify(reasons));
  ok(reasons.some(x => /סוג/.test(x)), 'וחסר סוג נדחה');
  ok(reasons.some(x => /עובדת/.test(x)), 'ותעודה של עובדת נשלחת למסך הנכון');

  const saved = await BranchCertification.findOne({ external_url: URL1 }).lean();
  ok(Boolean(saved), 'השורה נוצרה');
  eq(String(saved.branch_id), String(hz._id), 'על הסניף הנכון');
  eq(saved.cert_type, 'sanitarian', 'עם הסוג הנכון');
  ok(saved.file_data === null, 'והקובץ נשאר בדרייב — רק קישור');

  console.log('\nייבוא כפול');
  const r2 = await post('/drive/import', { items: [
    { file_name: 'תברואן הרצליה', url: URL1, kind: 'cert', type: 'sanitarian', branch_id: String(hz._id) },
  ] });
  eq(r2.body.created, 0, 'לא נוצר שוב');
  ok(/כבר מקושר/.test(r2.body.refused[0]?.reason || ''), 'ונאמר שהוא כבר מקושר');
  eq(await BranchCertification.countDocuments({ external_url: URL1 }), 1, 'ויש שורה אחת, לא שתיים');

  console.log('\nבלי הגדרת גוגל');
  const r3 = await fetch(base + '/drive/scan', { headers: { Authorization: `Bearer ${admin}` } });
  eq(r3.status, 503, 'הסריקה אומרת שהגישה לא מוגדרת, ולא קורסת');
  eq((await r3.json()).code, 'DRIVE_NOT_CONFIGURED', 'עם קוד שאפשר לפעול לפיו');

  // -------------------------------------- a back-office role, based on a teacher
  console.log('\nתפקיד בק-אופיס שמבוסס על גננת');
  const asUser = (claims) => {
    const t = jwt.sign({ id: String(new mongoose.Types.ObjectId()), ...claims },
      process.env.JWT_SECRET, { expiresIn: '1h' });
    return async (method, path, body) => {
      const r = await fetch(base + path, {
        method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
  };
  const plainTeacher = asUser({ role: 'teacher', branch_id: String(ks._id) });
  eq((await plainTeacher('GET', '/')).status, 403, 'גננת רגילה — אין גישה');

  const readerOnly = asUser({ role: 'teacher', branch_id: String(ks._id),
    role_tab_add: ['branch_certifications'] });
  eq((await readerOnly('GET', '/')).status, 200,
    'מי שקיבלה את הטאב רואה את המסך — זה הבאג של עינת');
  eq((await readerOnly('POST', '/', { branch_id: String(hz._id), cert_type: 'sanitarian' })).status, 403,
    'אבל בלי הרשאת כתיבה לא משנה כלום');

  const filer = asUser({ role: 'teacher', branch_id: String(ks._id),
    role_tab_add: ['branch_certifications', 'branch_certifications_write'] });
  const seen = await filer('GET', '/');
  eq(seen.status, 200, 'עם הרשאת כתיבה — רואה');
  eq((seen.body.branches || []).length, 2, 'ואת כל הסניפים, לא רק את שלה');
  const made = await filer('POST', '/', {
    branch_id: String(hz._id), cert_type: 'electrician', external_url: 'https://x/file/d/ZZZZZZZZZZZZ/view',
  });
  eq(made.status, 201, 'ומעלה אישור לסניף שאינו שלה');

  // ------------------------------------------------------------ the gaps
  console.log('\nמה שחסר — ולא נראה בטבלה');
  const certGaps = require('../src/services/certGaps.service');
  const { REQUIRED_CERT_TYPES } = require('../src/services/compliance');

  let list = await certGaps.gaps();
  const hzGap = list.find(g => g.branch_name === 'הרצליה הרצוג');
  eq(hzGap.required_count, REQUIRED_CERT_TYPES.length, 'נדרשים נספרים מול רשימה אחת');
  // The sanitarian imported above has no expiry, so it is held and not missing.
  ok(!hzGap.missing.includes('sanitarian'), 'אישור שהועלה אינו "חסר"');
  ok(hzGap.no_expiry.includes('sanitarian'), 'אבל בלי תאריך תפוגה הוא נספר בנפרד');
  ok(hzGap.missing.includes('operating_license'), 'ורישיון הפעלה שלא הועלה — חסר');

  // A valid certificate clears the gap entirely.
  const future = new Date(Date.now() + 200 * 86400000);
  await BranchCertification.create({
    branch_id: hz._id, cert_type: 'electrician', expires_at: future, external_url: 'u1',
  });
  list = await certGaps.gaps();
  const after = list.find(g => g.branch_name === 'הרצליה הרצוג');
  ok(!after.missing.includes('electrician'), 'חשמלאי בתוקף — לא חסר');
  ok(!after.no_expiry.includes('electrician'), 'וגם לא "בלי תאריך"');

  // An expired one is a different problem from a missing one.
  await BranchCertification.create({
    branch_id: hz._id, cert_type: 'nutritionist',
    expires_at: new Date(Date.now() - 10 * 86400000), external_url: 'u2',
  });
  list = await certGaps.gaps();
  const exp = list.find(g => g.branch_name === 'הרצליה הרצוג');
  ok(exp.expired.includes('nutritionist'), 'תזונאית שפגה — "פג תוקף"');
  ok(!exp.missing.includes('nutritionist'), 'ולא "חסר" — הנייר קיים');

  // An ARCHIVED certificate does not cover the year.
  await BranchCertification.create({
    branch_id: hz._id, cert_type: 'safety_inspector', expires_at: future,
    is_archived: true, external_url: 'u3',
  });
  list = await certGaps.gaps();
  ok(list.find(g => g.branch_name === 'הרצליה הרצוג').missing.includes('safety_inspector'),
    'אישור בארכיון לא מכסה — נשאר חסר');

  const lines = certGaps.describe(list);
  ok(lines.some(l => /הרצליה/.test(l) && /חסרים/.test(l)), 'הנוסח להודעה נבנה', JSON.stringify(lines).slice(0,120));
  ok(certGaps.describe([{ branch_name: 'x', missing: [], expired: [], no_expiry: [], total_gaps: 0 }]).length === 0,
    'וסניף תקין לא מופיע בהודעה בכלל');

  console.log(failures === 0 ? `\n✅  הכל עבר\n` : `\n❌  ${failures} נכשלו\n`);
  await mongoose.disconnect();
  server.close();
  await mongo.stop();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('\n💥', e); process.exit(1); });
