/**
 * What a parent may change, and what happens when they do.
 *
 * The gan's rule: a parent corrects their own details without waiting for
 * anyone, and the staff must know it happened. The second half is not a
 * courtesy — for allergies it is the safety mechanism, since the change is
 * already live by the time anybody reads about it.
 *
 * Two things are deliberately NOT in the editable list.
 *
 * The phone, because it is where every future login code is sent: a parent
 * who could change it from inside a session could be an attacker who got in
 * once and now owns the account forever. It has its own flow, and the code
 * goes to the new number.
 *
 * The child's name and birth date, because they are not the parent's to
 * correct — they identify the child across years and across the ministry's
 * lists, and a typo fixed here would silently split one child into two.
 */

const { ParentPortalChange } = require('../models');

/**
 * The whitelist. A field absent from here cannot be written by a parent, no
 * matter what the request body says.
 *
 * Health is separated from contact only so the two land as different rows with
 * different severities — an allergy edit must not queue behind a house number.
 */
const EDITABLE = {
  contact: {
    address: 'כתובת',
    emergency_contact: 'איש קשר לחירום',
    emergency_phone: 'טלפון לחירום',
  },
  health: {
    allergies: 'אלרגיות',
    medical_alerts: 'הערות רפואיות',
  },
};

const SEVERITY = { contact: 'normal', health: 'high' };

const MAX_LENGTH = 500;

/**
 * Read a submitted body against the whitelist and against what is already
 * stored, returning only what genuinely differs.
 *
 * Returns { updates, byCategory, errors }. `updates` is the flat field→value
 * map to write; `byCategory` is what to record, split so each category
 * becomes its own row.
 *
 * Whitespace-only edits are not changes. Neither is "" replacing null — both
 * mean "not recorded", and treating them as different would fill the staff
 * screen with rows saying nothing happened.
 */
function diffEditable(body, current) {
  const updates = {};
  const byCategory = {};
  const errors = [];

  for (const [category, fields] of Object.entries(EDITABLE)) {
    for (const [field, label] of Object.entries(fields)) {
      if (!(field in (body || {}))) continue;

      const raw = body[field];
      if (raw !== null && raw !== undefined && typeof raw !== 'string') {
        errors.push(`${label}: ערך לא תקין`);
        continue;
      }
      const next = String(raw ?? '').trim();
      if (next.length > MAX_LENGTH) {
        errors.push(`${label}: ארוך מדי`);
        continue;
      }

      const before = String(current[field] ?? '').trim();
      if (before === next) continue;

      updates[field] = next;
      byCategory[category] = byCategory[category] || [];
      byCategory[category].push({ field, label, before: before || null, after: next || null });
    }
  }

  return { updates, byCategory, errors };
}

/**
 * Write the record of a change. Called before the change is applied, so a
 * write that fails here does not become a silent edit.
 */
async function recordChange({ account, child, category, changes, relatedAccountId }) {
  if (!changes.length) return null;
  return ParentPortalChange.create({
    parent_account_id: account._id,
    parent_id_number: account.id_number,
    parent_name: account.full_name || '',
    child_id: child?._id || null,
    child_name: child?.child_name || '',
    branch_id: child?.classroom_id?.branch_id || null,
    category,
    severity: SEVERITY[category] || 'normal',
    changes,
    related_account_id: relatedAccountId || null,
  });
}

module.exports = { EDITABLE, SEVERITY, diffEditable, recordChange };
