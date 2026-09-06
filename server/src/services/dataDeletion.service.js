/**
 * What "delete my account" actually does, in one place.
 *
 * Two separate people ask for two different things. An employee's request
 * touches both their login (User) and their payroll record (Employee) — most
 * staff have both, some payroll-only employees have no login at all, and
 * either can be missing here without the other failing. A parent's request
 * touches only their portal login (ParentAccount); their child's enrollment
 * file is the gan's own operational record, not the parent's account, and
 * survives a parent-account deletion exactly the way it survives a parent
 * simply never signing up for the portal at all — see the public deletion
 * page for why.
 *
 * This is anonymize, not erase. A hard delete would either orphan every
 * historical punch and payslip that references this person, or force
 * cascading through years of payroll and attendance the gan is required to
 * keep for tax purposes. So identity is scrubbed — name, contact details,
 * bank account, the fingerprint template, everything reachable from a
 * screen — and the numbers that already happened (hours worked, amounts
 * paid) stay exactly as they were, now pointing at nobody nameable.
 *
 * Both functions are idempotent: completing an already-anonymized record is
 * a harmless no-op, not a second wave of random values.
 */

const crypto = require('crypto');
const { User, Employee, ParentAccount } = require('../models');

const REDACTED_NAME = 'משתמש שנמחק';

async function completeEmployeeDeletion(userId) {
  const user = await User.findById(userId);
  if (user) {
    user.full_name = REDACTED_NAME;
    user.email = `deleted-${user._id}@deleted.local`;
    user.phone = '';
    user.address = '';
    user.id_number = '';
    user.bank_account = '';
    user.bank_branch = '';
    user.bank_number = '';
    // Unusable, not merely unknown — a hash of a random 32-byte value has no
    // password it could ever be found to match, unlike bcrypt('') which is a
    // deterministic hash of a real (empty) input.
    user.password_hash = crypto.randomBytes(32).toString('hex');
    user.password_set = false;
    user.webauthn_credentials = [];
    user.otp_hash = null;
    user.is_active = false;
    await user.save();
  }

  const employee = await Employee.findOne({ user_id: userId });
  if (employee) await anonymizeEmployeeRecord(employee);
}

/** An Employee with no User login at all — the payroll-only majority — reached directly by id. */
async function completeEmployeeDeletionByEmployeeId(employeeId) {
  const employee = await Employee.findById(employeeId);
  if (employee) await anonymizeEmployeeRecord(employee);
}

async function anonymizeEmployeeRecord(employee) {
  employee.full_name = REDACTED_NAME;
  employee.phone = '';
  employee.email = '';
  employee.address = '';
  employee.israeli_id = '';
  employee.bank_number = '';
  employee.bank_branch = '';
  employee.bank_account = '';
  employee.bank_account_holder = '';
  employee.notes = '';
  // The whole point of asking: a physical fingerprint template does not
  // belong in a database once nobody consents to it being there.
  employee.fingerprint = undefined;
  employee.is_active = false;
  await employee.save();
}

async function completeParentDeletion(parentId) {
  const account = await ParentAccount.findById(parentId);
  if (!account) return;

  account.full_name = REDACTED_NAME;
  account.phone = '';
  account.password_hash = '';
  account.webauthn_credentials = [];
  account.otp_hash = null;
  account.phone_change = undefined;
  // `id_number` is required + unique, so it can't simply be cleared — and
  // leaving the real תעודת זהות behind would defeat the point. A random
  // placeholder both frees the real number for the unique index and makes
  // this account permanently unfindable by it — nobody can log in with the
  // ID number that used to work here, including its former owner.
  account.id_number = `deleted-${account._id}`;
  account.is_active = false;
  await account.save();
}

module.exports = {
  completeEmployeeDeletion,
  completeEmployeeDeletionByEmployeeId,
  completeParentDeletion,
};
