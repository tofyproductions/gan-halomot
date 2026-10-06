#!/usr/bin/env node
/**
 * The login App Review signs in with.
 *
 * The store listing says a sign-in is required, so a reviewer who cannot get
 * in rejects the submission — they cannot see the app, and "it asked me for a
 * password" is a complete review. Google already has one of these ("Google
 * Reviewer", branch_manager, is_test_account), and this makes Apple's.
 *
 * SEPARATE FROM GOOGLE'S ON PURPOSE. One account for both stores means
 * revoking Apple's access revokes Google's, and the sign-in log cannot say
 * which reviewer looked. Two accounts cost nothing.
 *
 * `is_test_account` is the important field, not a nicety: without it this
 * login sits in the recipient lists beside the real managers and starts
 * receiving a branch's punch reminders, lead alerts, payroll mail and its
 * staff's payslips — a reviewer in California reading an Israeli gan's
 * salaries. See scripts/mark-test-accounts.js, which exists because that
 * happened.
 *
 * A branch_manager and not an admin: enough to see the application work,
 * not enough to change the network. The reviewer is checking that the screens
 * exist, not running the gan.
 *
 *   node scripts/make-reviewer-account.js                 # dry run
 *   node scripts/make-reviewer-account.js --write
 *   node scripts/make-reviewer-account.js --write --reset # new password for an existing one
 *
 * The password is printed ONCE, to this terminal. Paste it into App Store
 * Connect → App Review Information. It is not stored anywhere readable.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const WRITE = process.argv.includes('--write');
const RESET = process.argv.includes('--reset');

const FULL_NAME = 'Apple Reviewer';
const ID_NUMBER = '999999980';
const EMAIL = 'apple-reviewer@gan-halomot.local';

/** Long enough that nobody guesses it, typable enough that a reviewer can. */
function makePassword() {
  const words = crypto.randomBytes(9).toString('base64').replace(/[^A-Za-z0-9]/g, '');
  return `Gan-${words}`;
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI חסר');
  await mongoose.connect(uri);
  console.log(`מסד: ${mongoose.connection.host}/${mongoose.connection.name}\n`);

  const { User, Branch } = require('../src/models');

  // The same gan Google's reviewer was given, so both see the same thing.
  const google = await User.findOne({ full_name: 'Google Reviewer' }).select('branch_id').lean();
  const branch = google?.branch_id
    ? await Branch.findById(google.branch_id).select('name').lean()
    : await Branch.findOne({ is_active: true }).select('name').sort({ name: 1 }).lean();
  if (!branch) throw new Error('לא נמצא סניף');

  const existing = await User.findOne({ $or: [{ id_number: ID_NUMBER }, { email: EMAIL }] });

  if (existing && !RESET) {
    console.log('החשבון כבר קיים:');
    console.log(`  שם מלא:      ${existing.full_name}`);
    console.log(`  תעודת זהות:  ${existing.id_number}`);
    console.log(`  תפקיד:       ${existing.role}`);
    console.log(`  חשבון בדיקה: ${existing.is_test_account ? 'כן' : '❗ לא — יקבל מיילים אמיתיים של הגן'}`);
    console.log('\nאת הסיסמה אי אפשר לשחזר. לקביעת סיסמה חדשה: --write --reset');
    return;
  }

  const password = makePassword();
  const plan = existing ? 'איפוס סיסמה לחשבון קיים' : 'יצירת חשבון חדש';

  console.log(`${plan}:`);
  console.log(`  שם מלא:      ${FULL_NAME}`);
  console.log(`  תעודת זהות:  ${ID_NUMBER}`);
  console.log(`  תפקיד:       branch_manager`);
  console.log(`  סניף:        ${branch.name}`);
  console.log(`  חשבון בדיקה: כן (לא יקבל מיילים של הגן)`);

  if (!WRITE) {
    console.log('\nהרצה יבשה — שום דבר לא נכתב. להרצה בפועל: --write');
    return;
  }

  const password_hash = await bcrypt.hash(password, 10);
  if (existing) {
    existing.password_hash = password_hash;
    existing.password_set = true;
    existing.must_change_password = false;
    existing.is_active = true;
    existing.is_test_account = true;
    await existing.save();
  } else {
    await User.create({
      full_name: FULL_NAME,
      id_number: ID_NUMBER,
      email: EMAIL,
      role: 'branch_manager',
      branch_id: branch._id,
      managed_branch_ids: [branch._id],
      position: 'App Review',
      password_hash,
      password_set: true,
      must_change_password: false,
      is_active: true,
      is_test_account: true,
    });
  }

  console.log('\n✅ מוכן. להעתיק ל-App Store Connect → App Review Information:');
  console.log('─────────────────────────────────────────────');
  console.log(`  User name:  ${FULL_NAME}`);
  console.log(`  Password:   ${password}`);
  console.log('─────────────────────────────────────────────');
  console.log('\nהסיסמה מוצגת פעם אחת בלבד ואינה נשמרת בשום מקום קריא.');
  console.log('בשדה Notes כדאי לכתוב לבודק:');
  console.log('  "Sign in with the full name and the password above. The ID');
  console.log('   number field expects 999999980."');
}

main()
  .catch((err) => { console.error(`\n❌ ${err.message}`); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
