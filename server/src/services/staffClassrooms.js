/**
 * Which room a member of staff belongs to.
 *
 * THE SHAPE OF THE RULE. Every card may carry one primary room and any number
 * of additional ones. The primary is responsibility; the extras are where she
 * also helps out, and nothing reads them as responsibility. Keeping the
 * primary in its own field means "a second room is only ever additional" needs
 * no enforcing — there is one slot and it holds one room.
 *
 * WHO MUST HAVE ONE. Not everybody: a cook, a bookkeeper and a branch manager
 * have no room, and demanding one would make the screen refuse to save a
 * perfectly ordinary card. The people who must are the ones a child is handed
 * to — גננת, סייעת, מטפלת and their masculine forms. That list lives here
 * rather than in the schema so it can be argued with and changed without
 * touching stored data.
 *
 * The match is on a prefix rather than the whole string because the titles are
 * typed and drift: "סייעת בכירה", "גננת משלימה", "מטפלת - תינוקייה" are all
 * the same job for this purpose.
 */

const CLASSROOM_REQUIRED_PREFIXES = ['גננ', 'גנן', 'סייע', 'מטפל'];

/** Does this job title need a room? */
function positionNeedsClassroom(position) {
  const p = String(position || '').trim();
  if (!p) return false;
  return CLASSROOM_REQUIRED_PREFIXES.some((prefix) => p.startsWith(prefix));
}

const idStr = (v) => (v == null ? null : String(v._id || v));

/**
 * Clean a requested assignment, or explain why it cannot stand.
 *
 * Returns `{ error }` or `{ primary_classroom_id, extra_classroom_ids }`.
 * `body` carries only the keys the caller sent, so an edit that never mentions
 * rooms leaves the ones on the card alone.
 */
function planAssignment(employee, body = {}, { position } = {}) {
  const touchesPrimary = body.primary_classroom_id !== undefined;
  const touchesExtras = body.extra_classroom_ids !== undefined;
  if (!touchesPrimary && !touchesExtras) return null;

  const primary = touchesPrimary
    ? (body.primary_classroom_id ? String(body.primary_classroom_id) : null)
    : idStr(employee.primary_classroom_id);

  const rawExtras = touchesExtras
    ? (Array.isArray(body.extra_classroom_ids) ? body.extra_classroom_ids : [])
    : (employee.extra_classroom_ids || []);

  // A room listed as both primary and additional is one room, and the primary
  // is the meaningful half. Silently dropping the duplicate is right: the UI
  // that produced it was showing the same room in two lists.
  const extras = [...new Set(rawExtras.map(idStr).filter(Boolean))]
    .filter((id) => id !== primary);

  // Clearing the primary while keeping extras would leave a person assigned to
  // rooms with nobody responsible for any of them — the exact ambiguity the
  // single-primary field exists to prevent.
  if (!primary && extras.length) {
    return { error: 'לא ניתן להשאיר כיתות נוספות בלי כיתה ראשית. בחרו כיתה ראשית תחילה.' };
  }

  const effectivePosition = position !== undefined ? position : employee.position;
  if (!primary && positionNeedsClassroom(effectivePosition)) {
    return { error: `לתפקיד ${effectivePosition} חובה לשייך כיתה ראשית.` };
  }

  return { primary_classroom_id: primary, extra_classroom_ids: extras };
}

module.exports = {
  CLASSROOM_REQUIRED_PREFIXES,
  positionNeedsClassroom,
  planAssignment,
};
