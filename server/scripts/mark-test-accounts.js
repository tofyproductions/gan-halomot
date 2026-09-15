#!/usr/bin/env node
/**
 * Mark the logins that stand in for a person, so they stop receiving a real
 * gan's mail.
 *
 * Two accounts sit in the recipient lists beside the real managers:
 *
 *   Google Reviewer          branch_manager of כפר סבא - קפלן
 *   עמית קוחטה בדיקה 2       branch_manager of הרצליה הרצוג
 *
 * The first exists so Google can sign in and review the store build; the
 * second is a developer's. Both were receiving that branch's punch reminders,
 * lead alerts, payroll mail and its staff's payslips. Deactivating them would
 * break what they exist for, so `is_test_account` takes them out of the mail
 * and leaves the login working.
 *
 * NOT לינוי קוחטה, who is filed the same way and is a real employee. She is
 * already inactive, which is a different fact and already handled.
 *
 * Targets are written out by name AND checked against the role and branch they
 * were found with. If an account has changed since this was written, it is
 * skipped and reported rather than flagged on a guess — the same rule the
 * nursery import uses.
 *
 * One field, on two documents, from false to true. Nothing else is read or
 * written.
 *
 *   node scripts/mark-test-accounts.js            # dry run, changes nothing
 *   node scripts/mark-test-accounts.js --write    # for real
 *   node scripts/mark-test-accounts.js --undo --write
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { User, Branch } = require('../src/models');

const WRITE = process.argv.includes('--write');
const UNDO = process.argv.includes('--undo');

/** Written out, never derived. Each carries what it was when a person confirmed it. */
const TARGETS = [
  { full_name: 'Google Reviewer', role: 'branch_manager', branch: 'כפר סבא - קפלן' },
  { full_name: 'עמית קוחטה בדיקה 2', role: 'branch_manager', branch: 'הרצליה הרצוג' },
];

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const branches = await Branch.find({}).select('name').lean();
  const branchName = new Map(branches.map(b => [String(b._id), b.name]));

  const value = !UNDO;
  console.log(`\n${UNDO ? 'מבטל סימון' : 'מסמן'} חשבונות בדיקה — ${WRITE ? 'כתיבה אמיתית' : 'ריצה יבשה'}\n`);

  let changed = 0;
  let skipped = 0;
  for (const t of TARGETS) {
    const u = await User.findOne({ full_name: t.full_name })
      .select('full_name role is_active is_test_account managed_branch_ids branch_id').lean();

    if (!u) { console.log(`  ⏭  ${t.full_name} — לא נמצא`); skipped++; continue; }

    const covers = (u.managed_branch_ids || []).map(String);
    if (!covers.length && u.branch_id) covers.push(String(u.branch_id));
    const names = covers.map(id => branchName.get(id) || id);

    if (u.role !== t.role || !names.includes(t.branch)) {
      console.log(`  ⏭  ${t.full_name} — השתנה מאז (role=${u.role}, סניפים=${names.join('/') || '-'}), מדלג`);
      skipped++;
      continue;
    }
    if (!!u.is_test_account === value) {
      console.log(`  ✓  ${t.full_name} — כבר ${value ? 'מסומן' : 'לא מסומן'}`);
      continue;
    }

    console.log(`  →  ${t.full_name} (${t.branch}): is_test_account ${!!u.is_test_account} ⟶ ${value}`);
    if (WRITE) {
      await User.updateOne({ _id: u._id }, { $set: { is_test_account: value } });
    }
    changed++;
  }

  console.log(`\n${WRITE ? 'שונו' : 'ישתנו'}: ${changed} | דולגו: ${skipped}`);
  if (!WRITE) console.log('לא נכתב כלום. להרצה אמיתית הוסף --write\n');
  else console.log('לביטול: node scripts/mark-test-accounts.js --undo --write\n');

  await mongoose.disconnect();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
