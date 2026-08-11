const crypto = require('crypto');

/**
 * A hash of an object's MEANING, stable across key order.
 *
 * The obvious spelling of this is `JSON.stringify(obj, Object.keys(obj).sort())`
 * — and it is silently, catastrophically wrong. A second argument that is an
 * array is a property ALLOWLIST, not a sort order, and it is applied at every
 * depth: any nested key not in that top-level list is dropped. An enrollment
 * hashed that way came out as `{"academic_year":"…","child":{},"parent1":{}}`,
 * so two different children with the same year hashed identically, and every
 * re-import reported "unchanged" no matter what had actually changed in the
 * file. Both import flows used it.
 *
 * So the keys are sorted by walking the object instead. Dates are normalized to
 * their ISO form, because a value read back out of Mongo is a Date where the
 * freshly parsed one may still be a string, and that difference is not a change
 * to the data.
 */
function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  return JSON.stringify(String(value));
}

/** sha256 of the stable form. */
function stableHash(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

module.exports = { stableStringify, stableHash };
