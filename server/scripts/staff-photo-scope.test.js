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
  await Classroom.create({
    name: 'בוגרים', branch_id: kaplan._id, academic_year: YEAR, is_active: true,
  });
  await Classroom.create({
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
    role: 'class_leader', branch_id: kaplan._id, managed_branch_ids: [], classroom_id: babies._id,
  };
  check('רואה את הכיתה שלה בלבד',
    names(await visibleClassrooms(withRoom)) === 'תינוקיה',
    names(await visibleClassrooms(withRoom)));

  const assistantSameRoom = {
    role: 'assistant', branch_id: kaplan._id, managed_branch_ids: [], classroom_id: babies._id,
  };
  check('  וכל הצוות של אותה כיתה רואה את אותו דבר',
    names(await visibleClassrooms(assistantSameRoom)) === 'תינוקיה');

  const noRoom = {
    role: 'teacher', branch_id: kaplan._id, managed_branch_ids: [], classroom_id: null,
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
