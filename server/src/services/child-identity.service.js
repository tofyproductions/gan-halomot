/**
 * Is this the same child, or two children who share a name?
 *
 * The name alone cannot answer it. A gan of eighty has more than one אופק and
 * more than one נועם, and telling them apart matters in both directions: a
 * duplicate that goes unnoticed bills a family twice, and a false duplicate
 * blocks a real registration for a real child.
 *
 * The parent is not the answer either. The two rows that started this were
 * "שי נוטי" and "סברינה נוטי" — different names, different ID numbers,
 * different phones, one child. Two parents of one child differ on every parent
 * field there is, so any rule built on them declares the same child to be two.
 *
 * The birth date is the answer. It is on every registration in the system, it
 * belongs to the child rather than to whoever filled the form, and two children
 * of the same name in one gan year with the same date of birth do not happen.
 */

const { normalizeChildName } = require('./academic-year.service');

/** Digits only — 054-911-0041, 0549110041 and +972549110041 are one number. */
function phoneDigits(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.replace(/^972/, '0');
}

/** A date reduced to the day, so a timestamp difference is not a difference. */
function dayKey(date) {
  if (!date) return null;
  const d = new Date(date);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** The child's own ID number, wherever this registration happens to carry it. */
function childIdNumber(reg, child) {
  const raw = child?.child_id_number
    || reg?.child_id_number
    || reg?.configuration?.registration_card?.childIdNumber
    || null;
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.length >= 5 ? digits : null;
}

/**
 * Compare two registrations that already share a name.
 *
 * Returns 'same', 'different', or 'unknown' — and 'unknown' is a real answer,
 * not a failure. A registration with no birth date and no matching parent
 * detail might be either, and saying so lets the interface ask instead of
 * guessing: blocking outright would stop a legitimate second child, and
 * allowing silently is how the gan ends up billing one family twice.
 */
function compareChildIdentity(a, b, childA = null, childB = null) {
  if (normalizeChildName(a?.child_name) !== normalizeChildName(b?.child_name)) {
    return { verdict: 'different', reason: 'שם שונה' };
  }

  // A child's own ID number settles it in either direction.
  const idA = childIdNumber(a, childA);
  const idB = childIdNumber(b, childB);
  if (idA && idB) {
    return idA === idB
      ? { verdict: 'same', reason: 'אותה ת.ז' }
      : { verdict: 'different', reason: 'ת.ז שונה' };
  }

  // The birth date is on every registration, and it is the child's own.
  const birthA = dayKey(a?.child_birth_date || childA?.birth_date);
  const birthB = dayKey(b?.child_birth_date || childB?.birth_date);
  if (birthA && birthB) {
    return birthA === birthB
      ? { verdict: 'same', reason: 'אותו שם ואותו תאריך לידה' }
      : { verdict: 'different', reason: `תאריך לידה שונה (${birthA} מול ${birthB})` };
  }

  // No birth date on one of them. A shared parent still says something — but
  // only in one direction: parents who match mean one child, parents who
  // differ mean nothing at all, because a child has two of them.
  if (a?.parent_id_number && a.parent_id_number === b?.parent_id_number) {
    return { verdict: 'same', reason: 'אותו הורה (ת.ז)' };
  }
  const phoneA = phoneDigits(a?.parent_phone);
  if (phoneA && phoneA === phoneDigits(b?.parent_phone)) {
    return { verdict: 'same', reason: 'אותו טלפון הורה' };
  }

  return { verdict: 'unknown', reason: 'שם זהה, אין תאריך לידה להשוואה' };
}

module.exports = { compareChildIdentity, phoneDigits, childIdNumber };
