#!/usr/bin/env node
/**
 * A טופס 101 belongs to the employer written on it.
 *
 * mail-sorter offers every 101 to BOTH businesses on purpose (its
 * pull.routes.ts: "A 101 is about a PERSON, not a business … each keeps the ones
 * it recognises"). חברים של טופי takes its own by ID. The גן took every one,
 * paid to read it, and put whatever matched no גן employee into its review queue
 * as "לא נמצא עובד תואם" — as if a form for another company were a problem to
 * solve. On 30.09.2026 that queue held 16 forms and 15 of them read
 * "חברים של טופי בע"מ" on the employer line.
 *
 * In Israel an employee with two employers files a 101 to EACH, so a טופי form
 * is not a גן form even when the same woman works in both places. That makes the
 * employer check a correctness rule, not only noise removal: were it to run
 * after the ID match, a טופי form whose ID belongs to someone who also works at
 * the גן would be filed as HER גן 101.
 *
 * Pinned here:
 *   1. otherEmployer() recognises טופי in either quote style — the real queue
 *      had 12 × בע"מ and 3 × בע״מ — and only on a POSITIVE match. An unread,
 *      unknown or misspelt employer is not "another company": dropping those
 *      would lose real גן forms silently.
 *   2. classifyScan() checks the employer BEFORE the ID.
 *   3. reclassifyQueuedOtherEmployer() moves what is already queued, from the
 *      employer name stored on each row — no re-scan, no cost — and leaves the
 *      גן form alone.
 *
 *   npm install --no-save mongodb-memory-server
 *   node scripts/form101-other-employer.test.js
 */
try { require.resolve('mongodb-memory-server'); } catch {
  console.error('\n❌  חסרה חבילת הבדיקה. הרץ:\n\n   npm install --no-save mongodb-memory-server\n');
  process.exit(1);
}

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let failures = 0;
const ok = (cond, label) => { console.log(`  ${cond ? '✅' : '❌'} ${label}`); if (!cond) failures++; };
const eq = (a, b, label) => {
  const good = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  ${good ? '✅' : '❌'} ${label}${good ? '' : `  (קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)})`}`);
  if (!good) failures++;
};

(async () => {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri('gan_f101_test'), { dbName: 'gan_f101_test' });
  const { Employee, Form101Inbox } = require('../src/models');
  const form101 = require('../src/services/form101');

  console.log('\n🏢  מי המעסיק שעל הטופס\n');
  {
    const other = (employer_name) => form101.otherEmployer({ employer_name });
    ok(!!other('חברים של טופי בע"מ'), 'חברים של טופי בע"מ — מעסיק אחר');
    ok(!!other('חברים של טופי בע״מ'), 'וגם בגרשיים עבריים (3 מתוך 15 בתור האמיתי)');
    ok(!!other('  חברים  של טופי  '), 'רווחים כפולים לא מפריעים');
    eq(other('גן החלומות'), null, 'גן החלומות — שלנו');
    eq(other('עמותת גן החלומות'), null, 'עמותת גן החלומות — שלנו');
    eq(other('אמונה - כפר סבא'), null, 'עמותה של הגן — שלנו');
    eq(other(''), null, 'מעסיק שלא נקרא — לא "אחר"; נשאר במסלול הרגיל');
    eq(other(null), null, 'null — אותו דבר');
    eq(other('חברת הדפוס בע"מ'), null, 'מעסיק לא מוכר — לא "אחר"; אדם יבדוק');
    ok(typeof other('חברים של טופי בע"מ') === 'string', 'ומחזיר תווית קריאה, לא רק true');
  }

  // One גן employee whose ID also appears on a טופי form — she works in both.
  const branch_id = new mongoose.Types.ObjectId();
  const both = await Employee.create({
    full_name: 'רחל עובדת-כפולה', israeli_id: '111111118', is_active: true, branch_id,
  });
  const ganOnly = await Employee.create({
    full_name: 'שרה גן', israeli_id: '222222226', is_active: true, branch_id,
  });

  console.log('\n🔀  המעסיק נבדק לפני הת"ז\n');
  {
    const r = await form101.classifyScan(
      { employer_name: 'חברים של טופי בע"מ', israeli_id: '111111118', employee_name: 'רחל עובדת-כפולה' },
      null, {},
    );
    eq(r.kind, 'other_employer', 'טופס של טופי שהת"ז שלו תואמת עובדת גן — עדיין של טופי');
    ok(!r.employee, 'ולא משויך לה כטופס 101 של הגן');

    const g = await form101.classifyScan(
      { employer_name: 'גן החלומות', israeli_id: '222222226', employee_name: 'שרה גן' }, null, {},
    );
    eq(g.kind, 'match', 'טופס של הגן — המסלול הרגיל');
    eq(String(g.employee?._id), String(ganOnly._id), 'ומשויך לעובדת הנכונה');

    const u = await form101.classifyScan(
      { employer_name: '', israeli_id: '222222226', employee_name: 'שרה גן' }, null, {},
    );
    eq(u.kind, 'match', 'מעסיק שלא נקרא — עדיין משויך לפי ת"ז, לא נזרק');

    const n = await form101.classifyScan(
      { employer_name: 'גן החלומות', israeli_id: '999999998', employee_name: 'לא קיימת' }, null, {},
    );
    eq(n.kind, 'match', 'טופס גן בלי עובדת תואמת — המסלול הרגיל');
    ok(!n.employee && /לא נמצא/.test(n.reason || ''), 'ומגיע לתור עם הסיבה הרגילה');
  }

  console.log('\n🧹  מה שכבר בתור\n');
  {
    const row = (employer, name) => ({
      file_data: 'x', file_name: 'f.pdf', hash: `${employer}-${name}-${Math.random()}`,
      status: 'pending', reason: 'לא נמצא עובד תואם לפרטים שבטופס',
      scan: { is_form_101: true, employer_name: employer, employee_name: name, israeli_id: '1' },
    });
    await Form101Inbox.insertMany([
      row('חברים של טופי בע"מ', 'א'), row('חברים של טופי בע"מ', 'ב'), row('חברים של טופי בע״מ', 'ג'),
      row('גן החלומות', 'עובדת הגן'),
      row('', 'לא נקרא'),
    ]);
    const moved = await form101.reclassifyQueuedOtherEmployer();
    eq(moved, 3, 'שלושת טפסי טופי הועברו');
    eq(await Form101Inbox.countDocuments({ status: 'pending' }), 2, 'ושניים נשארו בתור');
    const stay = await Form101Inbox.find({ status: 'pending' }).lean();
    ok(stay.some(s => s.scan.employee_name === 'עובדת הגן'), 'טופס הגן נשאר');
    ok(stay.some(s => s.scan.employee_name === 'לא נקרא'), 'וגם הטופס שהמעסיק שלו לא נקרא');
    const gone = await Form101Inbox.find({ status: 'other_employer' }).lean();
    ok(gone.every(g => /טופי/.test(g.reason)), 'והסיבה אומרת למי הם שייכים');
    eq(await form101.reclassifyQueuedOtherEmployer(), 0, 'הרצה שנייה — לא עושה כלום');
  }

  console.log('\n📨  הת"ז מכותרת המייל של טפז\n');
  {
    // What the employee TYPED into Tepez, in the subject and the filename. The
    // scan reads the same number off the PDF Tepez rendered from it — and on an
    // 8-digit ID it "completes" it with a digit that does not exist instead of
    // padding a 0 (גאליה כהן: 51429389 read as 514293893, 30.09.2026).
    eq(form101.idFromMail('טופס 101 - גאליה כהן - 51429389', ''), '51429389', '8 ספרות מהכותרת');
    eq(form101.idFromMail('טופס 101 - טליה כהן - 219909041', ''), '219909041', '9 ספרות מהכותרת');
    eq(form101.idFromMail('', 'טופס 101 - גאליה כהן - 51429389.pdf'), '51429389', 'ומשם הקובץ כשאין בכותרת');
    eq(form101.idFromMail('טופס 101 לשנת 2026', ''), '', '"101" ושנה אינם ת"ז');
    eq(form101.idFromMail('Re: payslip', 'scan.pdf'), '', 'מייל שאינו של טפז — ריק, והסריקה תקבע');

    const galia = await Employee.create({
      full_name: 'גאליה כהן', israeli_id: '051429389', is_active: true, branch_id,
    });
    const scan = { employer_name: 'גן החלומות', israeli_id: '514293893', employee_name: 'גאליה כהן' };
    const withoutMail = await form101.classifyScan(scan, null, {});
    ok(!withoutMail.employee || String(withoutMail.employee._id) !== String(galia._id) || withoutMail.basis === 'name',
      'בלי הכותרת — הת"ז השגויה מהסריקה לא מוצאת אותה לפי ת"ז');
    const withMail = await form101.classifyScan(scan, null, { mailId: '51429389' });
    eq(String(withMail.employee?._id), String(galia._id), 'עם הכותרת — נמצאת: 51429389 → 051429389');
    eq(withMail.basis, 'mail_subject_id', 'ובסיס השיוך אומר שזה מהכותרת');
    const scanOnly = await form101.classifyScan(
      { employer_name: 'גן החלומות', israeli_id: '222222226', employee_name: 'שרה גן' }, null, { mailId: '' },
    );
    eq(scanOnly.basis, 'israeli_id', 'בלי ת"ז בכותרת — חוזרים לסריקה כמו היום');

    // What is already queued: re-matched from the subject stored on the row,
    // then attached exactly the way the manual "שייך" button attaches it.
    await Form101Inbox.create({
      file_data: Buffer.from('%PDF-1.4 galia').toString('base64'), file_name: 'טופס 101 - גאליה כהן - 51429389.pdf',
      file_mimetype: 'application/pdf', hash: 'galia-hash', status: 'pending',
      mail: { from: 'noreply@tepez.co.il', subject: 'טופס 101 - גאליה כהן - 51429389' },
      scan: { is_form_101: true, employer_name: 'גן החלומות', employee_name: 'גאליה כהן', israeli_id: '514293893', tax_year: 2026 },
      reason: 'לא נמצא עובד תואם לפרטים שבטופס',
    });
    const r = await form101.rematchPending();
    eq(r.attached, 1, 'הטופס של גאליה שויך');
    const item = await Form101Inbox.findOne({ hash: 'galia-hash' }).lean();
    eq(item.status, 'assigned', 'והפריט בתור סומן כמשויך');
    eq(String(item.assigned_to), String(galia._id), 'אליה');
    const { EmployeeDocument } = require('../src/models');
    const doc = await EmployeeDocument.findById(item.assigned_document_id).lean();
    eq(doc?.doc_type, 'form_101', 'ונוצר לה טופס 101 בתיק');
    eq(doc?.match_basis, 'mail_subject_id', 'עם בסיס השיוך הנכון');
    eq((await form101.rematchPending()).attached, 0, 'הרצה שנייה — לא משייכת שוב');
  }

  console.log(failures ? `\n❌  ${failures} כשלונות\n` : '\n✅  הכל עבר\n');
  await mongoose.disconnect();
  await mongo.stop();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('\n❌  נפילה:', e.message); process.exit(1); });
