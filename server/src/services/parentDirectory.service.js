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
const { normalizeChildName } = require('./academic-year.service');

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
    // The parent fields answer "is this ID this child's parent, and how do we
    // reach them"; the dates are what the portal shows about the enrolment.
    .populate('registration_id', 'parent_name parent_phone parent_id_number start_date end_date')
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
 * The identity of a child, across the years.
 *
 * There is one Child row per child PER ACADEMIC YEAR, so a family enrolled two
 * years running has four rows for two children — and the portal listed all
 * four, showing a parent their son twice under the same name. Which reads as a
 * broken application, not as a record of two enrolments.
 *
 * Name and birth date are what identify the same child across those rows;
 * household.service already groups registrations the same way.
 */
function childBirth(child) {
  if (!child.birth_date) return '';
  const d = new Date(child.birth_date);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

function childIdentityKey(child) {
  return `${normalizeChildName(child.child_name)}|${childBirth(child)}`;
}

/**
 * One entry per child, newest enrolment first, each carrying every year's row.
 *
 * `current` is what the screen shows; `years` is every enrolment behind it,
 * which is where the earlier contracts live. The caller gets both rather than
 * having to choose between "show the child once" and "show all their
 * contracts".
 */
function groupByChild(children) {
  // Name first, birth date only as a splitter.
  //
  // Keying on name+birth_date directly does not work, because birth_date is
  // filled in on some years and not others: the same child came back as two
  // children, which is the bug this function exists to prevent. So rows are
  // gathered by name, and split apart only when two of them both carry a
  // birth date and the dates disagree — which is the only evidence available
  // that one family really does have two children of the same name.
  const byName = new Map();
  for (const child of children) {
    const name = normalizeChildName(child.child_name);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(child);
  }

  const groups = [];
  for (const rows of byName.values()) {
    const buckets = [];
    for (const child of rows) {
      const birth = childBirth(child);
      // Join the first bucket this row does not contradict: same date, or
      // either side silent.
      const bucket = buckets.find(b => !b.birth || !birth || b.birth === birth);
      if (bucket) {
        bucket.years.push(child);
        if (!bucket.birth && birth) bucket.birth = birth;
      } else {
        buckets.push({ birth, years: [child] });
      }
    }
    // children arrive sorted by academic_year descending, so each bucket's
    // first row is its newest enrolment.
    for (const b of buckets) {
      groups.push({ key: childIdentityKey(b.years[0]), current: b.years[0], years: b.years });
    }
  }
  return groups;
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

  return { id_number: id, full_name: fullName, phone, children, groups: groupByChild(children) };
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

module.exports = {
  findParent, childrenOfParent, normalizeIdNumber, maskPhone, contactFromChild,
  childIdentityKey, groupByChild,
};
