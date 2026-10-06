#!/usr/bin/env node
/**
 * Mark the children who stand in for a child, so counts stop believing them.
 *
 * Four exist, one per branch — "ילד בדיקה משה דיין" and its siblings, filed
 * on 22.09.2026 — so that somebody can sign in as a parent and see what a
 * parent sees in each gan. They are worth keeping and they are not real, and
 * counted they made מעקב הורים רשומים wrong by four parents every day.
 *
 * The same shape as scripts/mark-test-accounts.js, which does this for the
 * staff logins that stand in for people: targets written out by name AND
 * checked against what they were found with, so a row that has changed since
 * this was written is skipped and reported rather than flagged on a guess.
 *
 * Marked, never deleted. One field, from false to true.
 *
 *   node scripts/mark-test-families.js            # dry run, changes nothing
 *   node scripts/mark-test-families.js --write
 *   node scripts/mark-test-families.js --undo --write
 */
require('dotenv').config();
const mongoose = require('mongoose');

const WRITE = process.argv.includes('--write');
const UNDO = process.argv.includes('--undo');

/** Written out, never derived. Each carries the ID it was filed under. */
const TARGETS = [
  { child_name: 'ילד בדיקה משה דיין', parent_id_number: '123456789' },
  { child_name: 'ילד בדיקה קפלן', parent_id_number: '123456788' },
  { child_name: 'ילד בדיקה יפו', parent_id_number: '123456777' },
  { child_name: 'ילד בדיקה הרצליה', parent_id_number: '123456666' },
  { child_name: 'ילד בדיקה', parent_id_number: '123456789' },
];

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI חסר');
  await mongoose.connect(uri);
  console.log(`מסד: ${mongoose.connection.host}/${mongoose.connection.name}\n`);

  const { Child, Registration } = require('../src/models');
  const want = !UNDO;

  let changed = 0;
  let skipped = 0;

  for (const t of TARGETS) {
    const regs = await Registration.find({ parent_id_number: t.parent_id_number })
      .select('_id').lean();
    const child = await Child.findOne({
      child_name: t.child_name,
      $or: [
        { parent_id_number: t.parent_id_number },
        { registration_id: { $in: regs.map(r => r._id) } },
      ],
    });

    if (!child) {
      skipped++;
      console.log(`  ⏭  "${t.child_name}" — לא נמצא עם ת.ז ${t.parent_id_number}, מדלג`);
      continue;
    }
    if (Boolean(child.is_test_account) === want) {
      console.log(`  ✓  "${t.child_name}" — כבר ${want ? 'מסומן' : 'לא מסומן'}`);
      continue;
    }

    console.log(`  ${WRITE ? '✅' : '•'} "${t.child_name}" → is_test_account = ${want}`);
    if (WRITE) {
      child.is_test_account = want;
      await child.save();
    }
    changed++;
  }

  console.log(`\n${changed} לשינוי, ${skipped} דולגו.`);
  if (!WRITE) console.log('הרצה יבשה — שום דבר לא נכתב. להרצה בפועל: --write');
}

main()
  .catch((err) => { console.error(`\n❌ ${err.message}`); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
