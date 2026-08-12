/**
 * Who is this ID number, and which children are theirs?
 *
 * Everything the portal shows hangs off this one answer, and it is answered
 * from the enrolment data rather than from anything the portal stores. A
 * parent's children change — one leaves in December, a sibling starts in
 * September, a classroom is reshuffled in the spring — and a copy held on the
 * account would be wrong from the first of those.
 *
 * The lookup goes through the REGISTRATION, and that is the whole trick.
 *
 * The obvious implementation asks the child record for its parent's ID, and
 * it does not work: of 71 active children, 63 have no parent_id_number at all
 * — the field is absent, not empty. Built that way the portal would have
 * admitted nine parents out of fifty-four and looked, from the outside, like
 * an application that simply did not know most of the families. The
 * registration each child came from carries the ID and the phone for every
 * one of them.
 *
 * So a parent is matched three ways, and any of them is enough: the child's
 * own parent slot, the child's second-parent slot (which is where the other
 * parent lives — a registration only ever carries one), and the parent on the
 * registration behind the child. Together they resolve every active child.
 *
 * Only active children count. An account whose children are all inactive is
 * refused a login — which is exactly how "the staff mark them inactive" turns
 * into a closed door, with no date arithmetic anywhere and therefore no gap
 * over the summer while next year's registration is still open.
 */

const { Child, Registration } = require('../models');
const { normalizePhone } = require('./sms.service');

/** Digits only. Typed ID numbers arrive with hyphens, spaces and stray marks. */
function normalizeIdNumber(raw) {
  return String(raw || '').replace(/\D/g, '');
}

/**
 * Every active child this ID number is a parent of, newest year first.
 *
 * Each child is returned with the registration it came from attached, because
 * the caller needs the parent details that live there and a second round trip
 * per child would be silly.
 */
async function childrenOfParent(idNumber) {
  const id = normalizeIdNumber(idNumber);
  if (!id) return [];

  // The registrations this person filed. This is the path that finds most
  // families — see the note above on the missing parent_id_number.
  const regs = await Registration.find({ parent_id_number: id })
    .select('_id parent_name parent_phone parent_id_number')
    .lean();
  const regIds = regs.map(r => r._id);

  const children = await Child.find({
    is_active: true,
    $or: [
      { parent_id_number: id },
      { parent2_id_number: id },
      ...(regIds.length ? [{ registration_id: { $in: regIds } }] : []),
    ],
  })
    .populate('classroom_id', 'name category branch_id')
    .populate('registration_id', 'parent_name parent_phone parent_id_number')
    .sort({ academic_year: -1, child_name: 1 })
    .lean();

  return children;
}

/**
 * The name and mobile this ID number is known by on one child.
 *
 * Checked in the order the data is trustworthy: the child's own parent slot,
 * then the second-parent slot, then the registration behind the child. The
 * last is the one that actually answers for most families.
 */
function contactFromChild(child, id) {
  const candidates = [];

  if (normalizeIdNumber(child.parent_id_number) === id) {
    candidates.push([child.parent_name, child.phone]);
  }
  if (normalizeIdNumber(child.parent2_id_number) === id) {
    candidates.push([child.parent2_name, child.parent2_phone]);
  }

  const reg = child.registration_id;
  if (reg && typeof reg === 'object' && normalizeIdNumber(reg.parent_id_number) === id) {
    candidates.push([reg.parent_name, reg.parent_phone]);
  }

  for (const [name, phone] of candidates) {
    const mobile = normalizePhone(phone);
    if (name || mobile) return { name: name ? String(name).trim() : '', phone: mobile };
  }
  return { name: '', phone: null };
}

/**
 * The parent themselves, as the enrolment data knows them.
 *
 * Returns { id_number, full_name, phone, children } or null when the ID number
 * is not a parent of any active child.
 *
 * A parent whose records carry no mobile at all comes back with phone: null —
 * the caller must treat that as "cannot activate on their own" rather than
 * silently doing nothing, since it is the one case that needs a human at the
 * gan. As of this writing every one of the fifty-four accounts has a usable
 * mobile, so it is a guard against future data rather than a live problem.
 */
async function findParent(idNumber) {
  const id = normalizeIdNumber(idNumber);
  if (!id) return null;

  const children = await childrenOfParent(id);
  if (children.length === 0) return null;

  let fullName = '';
  let phone = null;

  for (const child of children) {
    const { name, phone: mobile } = contactFromChild(child, id);
    if (!fullName && name) fullName = name;
    if (!phone && mobile) phone = mobile;
    if (fullName && phone) break;
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

module.exports = { findParent, childrenOfParent, normalizeIdNumber, maskPhone, contactFromChild };
