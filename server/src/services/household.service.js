/**
 * A child has two parents, and the system kept meeting them one at a time.
 *
 * A registration carries ONE parent — whoever filled the form. When the family
 * renews and the other parent signs, the new registration carries a different
 * name, a different ID number and a different phone, and nothing connects the
 * two. אמרי נוטי is registered by שי נוטי for one year and by סברינה נוטי for
 * the next; so are טאי שאול and רפאל חיים דוידוב. Three families that the data
 * describes as six.
 *
 * That split is not cosmetic. Siblings are grouped by the parent's ID number,
 * and a shared receipt only travels inside a group — so a payment made by one
 * parent is invisible to the other parent's child. And the contact list shows
 * whichever parent happened to sign, never the one you actually need to reach.
 *
 * The child is what joins them: the same child, by name and birth date, under
 * two parent identities means one household. That is the only signal used —
 * a shared surname is not evidence, and a shared phone is already covered by
 * the parent key itself.
 */

const { normalizeChildName } = require('./academic-year.service');
const { phoneDigits } = require('./child-identity.service');

/** The identity a registration files its parent under, as siblings are grouped. */
function parentKey(reg) {
  return reg?.parent_id_number?.trim()
    || reg?.parent_name?.trim()
    || reg?.parent_phone?.trim()
    || null;
}

/** The same child, by the fields that belong to the child. */
function childKey(reg) {
  const birth = reg?.child_birth_date ? new Date(reg.child_birth_date).toISOString().slice(0, 10) : '';
  return `${normalizeChildName(reg?.child_name)}|${birth}`;
}

/**
 * Group parent identities into households.
 *
 * Returns a function from a registration to its household key. Registrations
 * whose parents are never seen sharing a child keep their own key, so this is
 * a strictly coarser grouping than the parent key it replaces — nothing that
 * was together comes apart.
 */
function buildHouseholds(registrations) {
  const parent = new Map();
  const add = (x) => { if (x && !parent.has(x)) parent.set(x, x); };
  const find = (x) => {
    while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
    return x;
  };
  const union = (a, b) => {
    if (!a || !b) return;
    add(a); add(b);
    const ra = find(a); const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const r of registrations) add(parentKey(r));

  const byChild = new Map();
  for (const r of registrations) {
    const k = childKey(r);
    if (!k.includes('|') || !k.split('|')[0]) continue;
    byChild.set(k, [...(byChild.get(k) || []), r]);
  }
  for (const list of byChild.values()) {
    if (list.length < 2) continue;
    const keys = [...new Set(list.map(parentKey).filter(Boolean))];
    for (let i = 1; i < keys.length; i += 1) union(keys[0], keys[i]);
  }

  return (reg) => {
    const k = parentKey(reg);
    return k ? find(k) : null;
  };
}

/**
 * The other parent of this child, from a registration that carries them.
 *
 * Used when a Child record is written: the child ends up with both parents on
 * it even though no single registration ever held both. Never overwrites a
 * parent2 the family actually filled in on the registration card — that one
 * came from them, this one is inferred.
 */
function otherParentOf(reg, allRegistrations) {
  const me = parentKey(reg);
  const mine = childKey(reg);
  const other = allRegistrations.find(r => String(r._id) !== String(reg._id)
    && childKey(r) === mine
    && parentKey(r)
    && parentKey(r) !== me
    && phoneDigits(r.parent_phone) !== phoneDigits(reg.parent_phone));
  if (!other) return null;
  return {
    parent2_name: other.parent_name || null,
    parent2_id_number: other.parent_id_number || null,
    parent2_phone: other.parent_phone || null,
    parent2_email: other.parent_email || null,
  };
}

/**
 * Fill parent2 on a Child payload from the household, when the family did not
 * supply one themselves.
 *
 * The registration card asks for a second parent and almost nobody fills it —
 * one child record in seventy has one. But the second parent is already in the
 * system, on the registration they signed themselves, and a child record that
 * names only the parent who happened to sign is how a family gets split in two.
 */
async function attachSecondParent(payload, reg) {
  // The card wins. What the family typed is better evidence than what we infer.
  if (payload.parent2_name || payload.parent2_phone) return payload;

  const { Registration } = require('../models');
  const siblingsOfChild = await Registration.find({
    child_name: reg.child_name,
    _id: { $ne: reg._id },
  }).lean();
  const other = otherParentOf(reg, siblingsOfChild);
  return other ? { ...payload, ...other } : payload;
}

module.exports = { buildHouseholds, otherParentOf, attachSecondParent, parentKey, childKey };
