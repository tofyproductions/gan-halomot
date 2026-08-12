/**
 * Who is this ID number, and which children are theirs?
 *
 * Everything the portal shows hangs off this one answer, and it is answered
 * from the enrolment data rather than from anything the portal stores. A
 * parent's children change — one leaves in December, a sibling starts in
 * September, a classroom is reshuffled in the spring — and a copy held on the
 * account would be wrong from the first of those.
 *
 * A child names both parents (household.service writes them; the old records
 * were filled in by scripts/backfill-second-parent.js), so either ID number
 * finds the same family and both parents see the same thing. That is the
 * design: one account per parent, identical contents.
 *
 * Only active children count. An account whose children are all inactive is
 * refused a login — which is exactly how "the staff mark them inactive" turns
 * into a closed door, with no date arithmetic anywhere and therefore no gap
 * over the summer while next year's registration is still open.
 */

const { Child } = require('../models');
const { normalizePhone } = require('./sms.service');

/** Digits only. Typed ID numbers arrive with hyphens, spaces and stray marks. */
function normalizeIdNumber(raw) {
  return String(raw || '').replace(/\D/g, '');
}

/**
 * Every active child this ID number is a parent of, newest year first.
 *
 * Matched against both parent slots. The query normalises nothing on the
 * stored side, so an ID saved with a hyphen would be missed — the enrolment
 * path writes them clean, and the backfill script is where any historic mess
 * gets fixed rather than papered over with a regex on every login.
 */
async function childrenOfParent(idNumber) {
  const id = normalizeIdNumber(idNumber);
  if (!id) return [];

  return Child.find({
    is_active: true,
    $or: [{ parent_id_number: id }, { parent2_id_number: id }],
  })
    .populate('classroom_id', 'name category branch_id')
    .sort({ academic_year: -1, child_name: 1 })
    .lean();
}

/**
 * The parent themselves, as the enrolment data knows them.
 *
 * Returns { id_number, full_name, phone, children } or null when the ID number
 * is not a parent of any active child.
 *
 * The name and phone are read from whichever slot this ID sits in, per child;
 * the first child that carries a usable mobile decides the phone, because that
 * is the number the one-time code has to reach. A parent whose records carry
 * no mobile at all comes back with phone: null — the caller must treat that as
 * "cannot activate on their own" rather than silently doing nothing, since it
 * is the one case that needs a human at the gan.
 */
async function findParent(idNumber) {
  const id = normalizeIdNumber(idNumber);
  if (!id) return null;

  const children = await childrenOfParent(id);
  if (children.length === 0) return null;

  let fullName = '';
  let phone = null;

  for (const child of children) {
    const isFirst = normalizeIdNumber(child.parent_id_number) === id;
    const name = isFirst ? child.parent_name : child.parent2_name;
    const rawPhone = isFirst ? child.phone : child.parent2_phone;

    if (!fullName && name) fullName = String(name).trim();
    if (!phone) phone = normalizePhone(rawPhone);
  }

  return { id_number: id, full_name: fullName, phone, children };
}

/**
 * "05••••••19" — enough for a parent to recognise their own phone, not enough
 * for anyone else to learn it.
 */
function maskPhone(phone) {
  const p = normalizePhone(phone);
  if (!p) return null;
  return `${p.slice(0, 2)}${'•'.repeat(6)}${p.slice(-2)}`;
}

module.exports = { findParent, childrenOfParent, normalizeIdNumber, maskPhone };
