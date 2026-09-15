/**
 * The import, end to end, against a database that lives for eight seconds.
 *
 * `nursery-history-import.test.js` tests the conversion; this tests the thing
 * that writes. It boots an in-memory Mongo, seeds one branch, one תינוקייה and
 * the sixteen children from the export's own roster, and then runs the real
 * `importHistory` three times:
 *
 *   1. with no flags        — must write NOTHING, and still report what it would
 *   2. with write           — must write the days it just described
 *   3. with write again     — must change nothing, because the second run of an
 *                             import is the one that finds out whether it was
 *                             idempotent
 *
 * The database is created by this process and dies with it. Nothing here
 * touches a real one.
 *
 * Needs the export. Skipped without it:
 *   NURSERY_EXPORT_XLSX=/path/to/export.xlsx node scripts/nursery-history-e2e.test.js
 */

const assert = require('assert');
const fs = require('fs');

const EXPORT = process.env.NURSERY_EXPORT_XLSX;
if (!EXPORT || !fs.existsSync(EXPORT)) {
  console.log('\n(NURSERY_EXPORT_XLSX לא הוגדר — הבדיקה דולגה)\n');
  process.exit(0);
}

const BRANCH = 'כפר סבא - משה דיין';

let failures = 0;
function check(label, actual, expected) {
  try {
    assert.deepStrictEqual(actual, expected);
    console.log(`  ✓ ${label}`);
  } catch {
    failures += 1;
    console.log(`  ✗ ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

(async () => {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongoose = require('mongoose');
  const H = require('./lib/nursery-history');
  const { importHistory } = require('./import-nursery-history');

  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(`${mongo.getUri()}nursery-import-test`);
  const { Branch, Classroom, Child, DailyLog, DailyMenu } = require('../src/models');

  const branch = await Branch.create({ name: BRANCH });
  const room = await Classroom.create({
    name: 'תינוקייה א', category: 'תינוקייה', academic_year: '2026',
    branch_id: branch._id, is_active: true,
  });
  // The year the export covers ended on 27/08, and its children did not stay
  // infants. Seeding only the current roster would be seeding a gan that never
  // existed — and would hide the one decision this import turns on.
  const older = await Classroom.create({
    name: 'בוגרים א', category: 'בוגרים', academic_year: '2026',
    branch_id: branch._id, is_active: true,
  });

  const parsed = H.readWorkbook(EXPORT);
  const roster = parsed.children;
  const rosterNames = new Set(roster.map(c => c.name));

  const seed = (name, birth, classroom_id) => ({
    registration_id: new mongoose.Types.ObjectId(),
    child_name: name,
    birth_date: birth ? new Date(`${birth}T00:00:00Z`) : null,
    classroom_id, academic_year: '2026', is_active: true,
  });

  await Child.insertMany(roster.map(c => seed(c.name, c.birth_date, room._id)));

  // Everyone the history knows who is not on the roster any more, into בוגרים.
  const graduated = new Map();
  for (const snapshots of parsed.history.byDate.values()) {
    for (const c of snapshots[0].payload.children || []) {
      if (!rosterNames.has(c.name)) graduated.set(c.name, c.dob);
    }
  }
  await Child.insertMany([...graduated].map(([name, dob]) => seed(name, H.normalizeDateKey(dob) || null, older._id)));

  const opts = { file: EXPORT, branch: BRANCH, log: () => {} };
  console.log(`\nנזרעו ${roster.length} ילדים בתינוקייה ו-${graduated.size} שסיימו, בבוגרים`);

  // --- 1. the default is dry ---------------------------------------------
  console.log('\nללא דגלים — אסור שייכתב משהו');
  const dry = await importHistory({ ...opts });
  check('הדוח אומר שזו הרצה יבשה', dry.write, false);
  check('אין DailyLog', await DailyLog.countDocuments(), 0);
  check('אין DailyMenu', await DailyMenu.countDocuments(), 0);
  check('היא בכל זאת מתכננת ימים', dry.days > 0, true);
  check('היא בכל זאת מתכננת DailyLog', dry.logs_created > 0, true);
  check('היא בכל זאת מתכננת תפריטים', dry.menus_created > 0, true);
  check('היא לא מוצאת שדה בלי מיפוי', dry.unmapped_fields.size, 0);
  check('היא לא פוסלת אף ערך', dry.rejected_values, []);
  check('ב---scope branch כל ילד בהיסטוריה נמצא', dry.unresolved.size, 0);
  check('ואף אחד לא נשאר דו-משמעי', dry.ambiguous.size, 0);

  console.log('\n--scope — מי שסיים את השנה עדיין צריך להימצא');
  const narrow = await importHistory({ ...opts, scope: 'room' });
  // All but one: "יהב כאנה" appears for a single day with every field blank —
  // the day before the name was corrected to "יהב כהנא" — so it never reaches
  // the matcher at all. A child with nothing recorded is not an unresolved
  // child, and the report must not pad itself with them.
  check('--scope room מפספס את מי שעבר לבוגרים', narrow.unresolved.size, graduated.size - 1);
  check('…ולכן כותב הרבה פחות', narrow.child_days_written < dry.child_days_written / 4, true);
  check('--scope all מוצא את כולם גם כן', (await importHistory({ ...opts, scope: 'all' })).unresolved.size, 0);

  // --- 2. write -----------------------------------------------------------
  console.log('\nכתיבה — בדיוק מה שהובטח');
  const wrote = await importHistory({ ...opts, write: true });
  check('אותו מספר ימים כמו בהרצה היבשה', wrote.days, dry.days);
  check('אותו מספר DailyLog', wrote.logs_created, dry.logs_created);
  check('מספר המסמכים במסד תואם', await DailyLog.countDocuments(), wrote.logs_created);
  check('מספר התפריטים במסד תואם', await DailyMenu.countDocuments(), wrote.menus_created);

  const sample = await DailyLog.findOne({ 'meals.breakfast.amount': { $ne: '' } }).lean();
  check('יש רשומה עם ארוחת בוקר', !!sample, true);
  check('התאריך נשמר כמחרוזת YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(sample.date), true);
  // The child's room as it is TODAY, not the room they were in that January.
  // The board reads the log by child and date; the classroom on it is there so
  // a room's day can be queried, and the only room that has ever been true of
  // the document is the one the child is in.
  const owner = await Child.findById(sample.child_id).lean();
  check('הרשומה מקושרת לכיתה של הילד', String(sample.classroom_id), String(owner.classroom_id));
  check('הרשומה מקושרת לסניף', String(sample.branch_id), String(branch._id));
  check('שם הילד נשמר כ-snapshot', sample.child_name.length > 0, true);
  check('ארוחת בוקר היא אחוז מוצג', /%$/.test(sample.meals.breakfast.amount), true);

  const slept = await DailyLog.findOne({ 'sleep.morning.start': { $ne: '' } }).lean();
  check('שעת השכבה נשמרה כ-HH:MM', H.TIME_RE.test(slept.sleep.morning.start), true);

  const withMissing = await DailyLog.findOne({ 'missing.0': { $exists: true } }).lean();
  check('"מה חסר" נשמר כמערך', Array.isArray(withMissing.missing) && withMissing.missing.length > 0, true);

  const menu = await DailyMenu.findOne({}).lean();
  const menuKey = Object.keys(menu.selections)[0];
  check('מפתח התפריט הוא meal.category', /^(breakfast|lunch|snack)\./.test(menuKey), true);
  check('הבחירות הן מערכים גם כשיש מנה אחת', Array.isArray(menu.selections[menuKey]), true);

  // 2026-01-17 is the day whose LATER snapshot is an empty board — the archive
  // fired after the nightly reset. Importing it would have blanked the day.
  check('2026-01-17 יובא עם היום שבתוכו', await DailyLog.countDocuments({ date: '2026-01-17' }) > 0, true);
  const jan17 = wrote.conflicts.find(c => c.date === '2026-01-17');
  check('ההתנגשות ב-2026-01-17 מדווחת', !!jan17, true);
  check('…ונבחר בה ה-snapshot המוקדם', jan17.chosen, '17/01/2026 | 00:03');
  check('…ו---conflict latest היה בוחר אחרת', jan17.would_differ, true);

  // --- 3. idempotency -----------------------------------------------------
  console.log('\nהרצה שנייה — אסור שישתנה דבר');
  const before = await DailyLog.countDocuments();
  const again = await importHistory({ ...opts, write: true });
  check('לא נוצרו DailyLog נוספים', await DailyLog.countDocuments(), before);
  check('הדוח לא מדווח על יצירה', again.logs_created, 0);
  check('הדוח לא מדווח על עדכון', again.logs_updated, 0);
  check('לא נכתב אף שדה', again.fields_written, 0);
  check('כל השדות דווחו כנשמרים', again.fields_kept > 0, true);
  check('לא נוצרו תפריטים נוספים', again.menus_created, 0);
  check('התפריטים דווחו כללא שינוי', again.menus_unchanged, wrote.menus_created);
  check('כל רשומה קיימת מדווחת כהתנגשות', again.collisions.length > 0, true);

  // --- 4. insert-only: a row with anything in it is skipped whole ---------
  console.log('\ninsert-only — רשומה קיימת מדולגת ומדווחת, לא ממוזגת');
  await DailyLog.updateOne({ _id: sample._id }, {
    $set: { 'meals.breakfast.amount': '0%', 'meals.lunch.amount': '', staff_note: '', updated_by_name: 'גננת' },
  });
  const collided = await importHistory({ ...opts, write: true });
  const after = await DailyLog.findById(sample._id).lean();
  check('הערך של הצוות נשאר', after.meals.breakfast.amount, '0%');
  check('ושדה שהצוות ריקן לא מולא מהגיליון', after.meals.lunch.amount, '');
  const hit = collided.collisions.find(c => c.child_id === String(sample.child_id) && c.date === sample.date);
  check('ההתנגשות מדווחת עם התאריך והילד', !!hit, true);
  check('ועם השדות שגרמו לה', hit.fields.includes('meals.breakfast.amount'), true);
  check('ועם מי נגע בה', hit.edited_by, 'גננת');

  console.log('\n--overwrite הוא הדרך המפורשת לעקוף');
  // An explicit id, because --overwrite re-stamps what it rewrites: the row's
  // content now comes from THIS run, so this is the run that can take it back.
  const RUN = 'nursery-sheet:test:overwrite';
  await importHistory({ ...opts, write: true, overwrite: true, runId: RUN });
  check('--overwrite כן דורס', (await DailyLog.findById(sample._id).lean()).meals.breakfast.amount,
    sample.meals.breakfast.amount);
  check('ומחדש את חותמת המקור', (await DailyLog.findById(sample._id).lean()).import_source, RUN);

  // --- 4b. the undo button -----------------------------------------------
  console.log('\nמסלול חזרה — undo לפי run id');
  const { undoImport } = require('./import-nursery-history');
  const stamped = await DailyLog.countDocuments({ import_source: RUN });
  check('כל מה שנכתב נושא את ה-run id', stamped, wrote.logs_created);
  check('ואין רשומה מיובאת בלי חותמת', await DailyLog.countDocuments({ import_source: '' }), 0);

  // A row a teacher has since edited must survive the undo.
  const survivor = await DailyLog.findOne({ import_source: RUN }).lean();
  await DailyLog.updateOne({ _id: survivor._id }, { $set: { updated_by_name: 'גננת' } });

  const undoDry = await undoImport({ runId: RUN });
  check('undo יבש לא מוחק', await DailyLog.countDocuments({ import_source: RUN }), stamped);
  check('הוא מוצא את כל מה שנוצר', undoDry.found, stamped);
  check('ומחריג את מה שנערך מאז', undoDry.kept.length, 1);

  const undone = await undoImport({ runId: RUN, write: true });
  check('הכול נמחק חוץ מהנערך', await DailyLog.countDocuments({ import_source: RUN }), 1);
  check('הדוח מדווח כמה הוסרו', undone.removed, stamped - 1);
  check('התפריטים הוסרו גם הם', await DailyMenu.countDocuments({ import_source: RUN }), 0);
  check('ו-undo של run אחר לא נוגע בכלום', (await undoImport({ runId: 'nursery-sheet:אחר' })).found, 0);

  // Put it back, so the branch comparison below still has a database to read.
  await DailyLog.deleteMany({});
  await DailyMenu.deleteMany({});
  const rewrote = await importHistory({ ...opts, write: true });
  check('ייבוא חוזר אחרי undo מחזיר את הכול', rewrote.logs_created, wrote.logs_created);

  console.log('\nזיהוי מסד היעד');
  const { describeTarget } = require('./import-nursery-history');
  const t = describeTarget('mongodb+srv://user:hunter2@cluster0.abc.mongodb.net/gan-halomot?retryWrites=true');
  check('שם המסד מזוהה', t.db, 'gan-halomot');
  check('והסיסמה לא מודפסת', /hunter2/.test(`${t.host} ${t.db}`), false);

  // --- 5. the range and the branch ----------------------------------------
  console.log('\nטווח תאריכים וסניף');
  const ranged = await importHistory({ ...opts, from: '2026-03-01', to: '2026-03-31' });
  check('--from/--to מצמצם', ranged.days < dry.days && ranged.days > 0, true);
  check('הטווח מתחיל אחרי ה---from', ranged.date_from >= '2026-03-01', true);
  check('והטווח נגמר לפני ה---to', ranged.date_to <= '2026-03-31', true);

  let known = null;
  try { await importHistory({ ...opts, branch: 'סניף שלא קיים' }); }
  catch (e) { known = e.known === true; }
  check('סניף לא קיים נכשל בבירור ולא כותב', known, true);

  // --- 6. the second branch, which is not the same file ------------------
  //
  // Kaplan is the reason nothing above may assume a format. It changes shape
  // three days in — bare arrays, an Excel serial in the date column, a literal
  // "Unknown Date" — and it must land in the SAME collections, alongside Moshe
  // Dayan's, without either one disturbing the other.
  const KAPLAN = process.env.NURSERY_EXPORT_KAPLAN_XLSX;
  if (KAPLAN && fs.existsSync(KAPLAN)) {
    console.log('\nקפלן — אותו קוד, קובץ אחר');
    const kBranch = await Branch.create({ name: 'כפר סבא - קפלן' });
    const kRoom = await Classroom.create({
      name: 'תינוקייה קפלן', category: 'תינוקייה', academic_year: '2026',
      branch_id: kBranch._id, is_active: true,
    });

    const kParsed = H.readWorkbook(KAPLAN);
    const kNames = new Map();
    for (const snapshots of kParsed.history.byDate.values()) {
      for (const s of snapshots) {
        for (const c of H.historyChildren(s.payload)) if (c.name) kNames.set(c.name, c.dob);
      }
    }
    // "איתן חרמון" is deliberately NOT seeded: it is a one-day typo of
    // "איתן חכמון" and the import has to reach the same child through the
    // accessId rather than report a child nobody has.
    kNames.delete('איתן חרמון');
    await Child.insertMany([...kNames].map(([n, dob]) => seed(n, H.normalizeDateKey(dob) || null, kRoom._id)));

    const kOpts = { file: KAPLAN, branch: 'כפר סבא - קפלן', log: () => {} };
    const kDry = await importHistory({ ...kOpts });
    check('הצורות המעורבות נקראות', kDry.days > 200, true);
    check('אין שדה בלי מיפוי', kDry.unmapped_fields.size, 0);
    check('אין ערך שנפסל', kDry.rejected_values, []);
    check('שלוש שורות "Unknown Date" מדווחות ולא מיובאות', kDry.broken.length, 3);
    check('כולן בגלל התאריך', kDry.broken.every(b => b.raw === 'Unknown Date'), true);
    check('האיות הכפול אוחד', kDry.merged_names.map(m => [m.from, m.to]), [['איתן חרמון', 'איתן חכמון']]);
    check('ולכן אף ילד לא נשאר בלי התאמה', kDry.unresolved.size, 0);

    const kBefore = await DailyLog.countDocuments();
    const kWrote = await importHistory({ ...kOpts, write: true });
    check('נכתבו רשומות לקפלן', await DailyLog.countDocuments() - kBefore, kWrote.logs_created);
    check('כולן תחת הסניף של קפלן',
      await DailyLog.countDocuments({ branch_id: kBranch._id }), kWrote.logs_created);
    check('ומשה דיין לא זז', await DailyLog.countDocuments({ branch_id: branch._id }), before);

    // The days that arrive as a bare array, and the one archived forty times.
    check('13/01 — היום שהגיע כמערך חשוף — יובא',
      await DailyLog.countDocuments({ date: '2026-01-13', branch_id: kBranch._id }) > 0, true);
    const jan13 = kWrote.conflicts.find(c => c.date === '2026-01-13');
    // 43, not 40: forty rows spell the date "2026-01-13" and three more hold
    // the serial 46035, which is the same day. Before the serial was read they
    // were a separate, undated group that fell out of the import entirely.
    check('43 ה-snapshots של 13/01 מדווחים', jan13.options.length, 43);
    check('ונבחר בהם אחד שיש בו משהו', Math.max(...jan13.options.map(o => o.score)) > 0, true);
    check('⚠ latest היה מייבא יום ריק', jan13.would_differ, true);

    // The serial date, 46035, is 13/01/2026 — the same day, reached the other
    // way. If it were dropped the day would still exist and nobody would know.
    check('גם שורות ה-serial נחתו על אותו יום',
      jan13.options.some(o => typeof o.timestamp === 'number'), true);

    const kAgain = await importHistory({ ...kOpts, write: true });
    check('קפלן אידמפוטנטי גם הוא', kAgain.logs_created + kAgain.logs_updated, 0);
  } else {
    console.log('\n(NURSERY_EXPORT_KAPLAN_XLSX לא הוגדר — הבדיקות של קפלן דולגו)');
  }

  await mongoose.disconnect();
  await mongo.stop();

  console.log(failures === 0 ? '\nOK\n' : `\n${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
