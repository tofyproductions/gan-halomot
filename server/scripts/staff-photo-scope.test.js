/**
 * מי רואה אילו כיתות במסך התמונות.
 *
 * Two rules, and the first one locked a real person out of her own branch.
 *
 * `managed_branch_ids` is a management field. On a teaching row it is noise
 * that somebody left behind — and it used to REPLACE her own branch rather
 * than add to it, so a class leader at קפלן whose row still said משה דיין got
 * "אין לך הרשאה לצפות בסניף המבוקש" for the branch she actually works in,
 * with no way to understand why.
 *
 * The second is what the gan asked for: a teacher sees HER classroom, not the
 * whole branch. Everyone on that room's staff uploads and sees the same
 * photographs — the people who were there know what happened — but an
 * assistant in תינוקייה has no business in the בוגרים gallery, and a screen
 * offering her five rooms is a screen she will eventually upload to the wrong
 * one from.
 */
const assert = require('assert');

const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

const failures = [];
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

(async () => {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'scope' });

  const { Branch, Classroom, User } = require('../src/models');
  const { visibleClassrooms } = require('../src/controllers/photos.controller');
  const { resolveBranchScope } = require('../src/utils/branch-scope');

  const kaplan = await Branch.create({ name: 'כפר סבא - קפלן' });
  const dayan = await Branch.create({ name: 'כפר סבא - משה דיין' });
  const YEAR = '2026-2027';
  const babies = await Classroom.create({
    name: 'תינוקיה', branch_id: kaplan._id, academic_year: YEAR, is_active: true,
  });
  const olderRoom = await Classroom.create({
    name: 'בוגרים', branch_id: kaplan._id, academic_year: YEAR, is_active: true,
  });
  const dayanRoom = await Classroom.create({
    name: 'פעוטות', branch_id: dayan._id, academic_year: YEAR, is_active: true,
  });

  const names = (rooms) => rooms.map((r) => r.name).sort().join(', ');

  console.log('הסניף של מי שלא מנהל סניפים:');

  // The exact shape of the real account: she works at קפלן, and a stray
  // managed branch from somewhere else is sitting on her row.
  const stray = {
    id: new mongoose.Types.ObjectId(),
    role: 'assistant',
    branch_id: kaplan._id,
    managed_branch_ids: [dayan._id],
    classroom_id: null,
  };
  // The row exists because resolveBranchScope re-reads the user from the
  // database rather than trusting the token — the whole point of that file.
  const strayUser = await User.create({
    ...stray,
    _id: stray.id,
    full_name: 'לינוי',
    id_number: '324199108',
    email: 'linoy@scope.test',
    password_hash: 'x',
    is_active: true,
  });

  const scope = await resolveBranchScope({ user: { ...stray, _id: stray.id } });
  check('הסניף שלה בתוך ההרשאה', scope.map(String).includes(String(kaplan._id)),
    'זה הבאג שנתן לה 403 על הסניף שהיא עובדת בו');
  check('  וסניף זר שנשאר על השורה לא נכנס',
    !scope.map(String).includes(String(dayan._id)), JSON.stringify(scope));

  check('  והיא לא רואה כיתות בסניף הזר',
    !names(await visibleClassrooms(stray)).includes('פעוטות'));

  console.log('');
  console.log('מנהלת סניף — לא השתנתה:');
  const manager = {
    role: 'branch_manager', branch_id: kaplan._id, managed_branch_ids: [dayan._id],
  };
  const mScope = await resolveBranchScope({ user: manager });
  check('הסניפים שהיא מנהלת עדיין קובעים',
    mScope.map(String).includes(String(dayan._id)), JSON.stringify(mScope));

  console.log('');
  console.log('הכיתה של הגננת:');
  const withRoom = {
    role: 'class_leader', branch_id: kaplan._id, managed_branch_ids: [],
    classroom_ids: [babies._id],
  };
  check('רואה את הכיתה שלה בלבד',
    names(await visibleClassrooms(withRoom)) === 'תינוקיה',
    names(await visibleClassrooms(withRoom)));

  const assistantSameRoom = {
    role: 'assistant', branch_id: kaplan._id, managed_branch_ids: [],
    classroom_ids: [babies._id],
  };
  check('  וכל הצוות של אותה כיתה רואה את אותו דבר',
    names(await visibleClassrooms(assistantSameRoom)) === 'תינוקיה');

  const noRoom = {
    role: 'teacher', branch_id: kaplan._id, managed_branch_ids: [], classroom_ids: [],
  };
  check('  ומי שלא שויכה לכיתה רואה את הסניף — לא ננעלת',
    names(await visibleClassrooms(noRoom)) === 'בוגרים, תינוקיה',
    names(await visibleClassrooms(noRoom)));

  // A classroom that was closed must not strand her on an empty screen.
  await Classroom.updateOne({ _id: babies._id }, { $set: { is_active: false } });
  check('  וכיתה שנסגרה מחזירה אותה לסניף במקום למסך ריק',
    names(await visibleClassrooms(withRoom)) === 'בוגרים',
    names(await visibleClassrooms(withRoom)));
  await Classroom.updateOne({ _id: babies._id }, { $set: { is_active: true } });

  console.log('');
  console.log('שיוך לכמה כיתות:');
  const two = {
    role: 'assistant', branch_id: kaplan._id, managed_branch_ids: [],
    classroom_ids: [babies._id, olderRoom._id],
  };
  check('רואה בדיוק את שתי הכיתות שלה',
    names(await visibleClassrooms(two)) === 'בוגרים, תינוקיה',
    names(await visibleClassrooms(two)));

  // גננת אחת בשני סניפים — מקרה אמיתי, ולכן הכיתות גוברות על סינון הסניף.
  const across = {
    role: 'class_leader', branch_id: kaplan._id, managed_branch_ids: [],
    classroom_ids: [babies._id, dayanRoom._id],
  };
  check('  וכיתה בסניף אחר נכנסת גם היא',
    names(await visibleClassrooms(across)) === 'פעוטות, תינוקיה',
    names(await visibleClassrooms(across)));

  const acrossUser = await User.create({
    role: 'class_leader', branch_id: kaplan._id, managed_branch_ids: [],
    classroom_ids: [babies._id, dayanRoom._id],
    full_name: 'שתי כיתות', id_number: '324199200',
    email: 'two@scope.test', password_hash: 'x', is_active: true,
  });
  const acrossScope = await resolveBranchScope({
    user: { ...across, id: acrossUser._id, _id: acrossUser._id },
  });
  check('  והסניף השני נכנס להרשאה — אחרת היא רואה כיתה ונדחית עליה',
    acrossScope.map(String).includes(String(dayan._id)), JSON.stringify(acrossScope));
  await acrossUser.deleteOne();

  check('  רשימה ריקה מחזירה לסניף',
    names(await visibleClassrooms({
      role: 'teacher', branch_id: kaplan._id, managed_branch_ids: [], classroom_ids: [],
    })) === 'בוגרים, תינוקיה');

  console.log('');
  console.log('כשמעבירים עובדת לסניף אחר:');
  /**
   * שיוך מפורש לכיתה שורד החלפת סניף — וזו החלטה, לא תקלה.
   *
   * קודם `classroom_id` היה שדה שאיש לא הגדיר ביודעין, ולכן מצביע ישן שגבר
   * על הסניף היה באג. עכשיו הרשימה נקבעת במסך ההרשאות ביד של מנהל מערכת,
   * והמקרה "עובדת בשתי כיתות בשני סניפים" הוא בדיוק מה שהיא נועדה לו. לשלול
   * שיוך מפורש בגלל שינוי בשדה אחר היה מבטל את הפיצ'ר בשקט.
   *
   * המחיר: מי שמעביר סניף צריך לעדכן גם את הכיתות. המסך מציג אותן, ולכן זה
   * גלוי ולא נסתר.
   */
  const moved = {
    role: 'class_leader',
    branch_id: dayan._id,
    managed_branch_ids: [],
    classroom_ids: [babies._id],     // שויכה במפורש לחדר בקפלן
  };
  check('השיוך המפורש נשמר גם אחרי החלפת סניף',
    names(await visibleClassrooms(moved)) === 'תינוקיה',
    names(await visibleClassrooms(moved)));

  const movedNoRooms = {
    role: 'class_leader', branch_id: dayan._id, managed_branch_ids: [], classroom_ids: [],
  };
  check('  ומי שלא שויכה לכיתה עוברת עם הסניף',
    names(await visibleClassrooms(movedNoRooms)) === 'פעוטות',
    names(await visibleClassrooms(movedNoRooms)));

  console.log('');
  console.log('מנהלת מערכת:');
  check('רואה הכל', (await visibleClassrooms({ role: 'system_admin' })).length === 3);
  check('ומשתמש בלי סניף בכלל לא רואה כלום',
    (await visibleClassrooms({ role: 'teacher', managed_branch_ids: [] })).length === 0);

  await strayUser.deleteOne();
  await mongoose.disconnect();
  await mongod.stop();

  if (failures.length) { console.error(`\nFAIL — ${failures.length} שגויים`); process.exit(1); }
  console.log('\nPASS staff-photo-scope');
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
