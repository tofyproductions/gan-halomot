/**
 * רשימת הציוד של הגן — the list on the door, as data.
 *
 * This is the sheet handed to every family at the start of the year, so the
 * two say the same words: a parent told "חסר תמ״ל" should recognise the phrase
 * from the page on their fridge, not have to work out what it maps to.
 *
 * `key` is what gets stored, never the label. Renaming an item later — and the
 * kitchen does rename things — must not orphan every child already marked.
 *
 * The emoji and colour come from the printed sheet too. They are not
 * decoration here: on a phone, a list of nine identical grey rows is read by
 * nobody, and a parent who does not read it brings nothing.
 */

const CATALOGUE = [
  { key: 'diapers',    label: 'טיטולים',        emoji: '🧷', color: '#e8443b', hint: 'לפי הצורך — הצוות יעדכן' },
  { key: 'cream',      label: 'משחת החתלה',      emoji: '🧴', color: '#f5871f' },
  { key: 'wipes',      label: 'מגבונים',         emoji: '🧻', color: '#f0a500', hint: '4 חבילות בחודש' },
  { key: 'formula',    label: 'תמ״ל',            emoji: '📦', color: '#2bb673' },
  { key: 'bedding',    label: 'מצעים',           emoji: '🛏️', color: '#17a2b8', hint: 'סדין ושמיכה עם השם + סדין נקי במגירה' },
  { key: 'pacifier',   label: 'מוצצים',          emoji: '👶', color: '#2e7dd7', hint: '2' },
  { key: 'bottles',    label: 'בקבוקי חלב',      emoji: '🍼', color: '#5b57c9', hint: '2, במידה וצריך' },
  { key: 'water',      label: 'בקבוק מים',       emoji: '💧', color: '#8e44ad', hint: 'עם השם' },
  { key: 'clothes',    label: 'בגדי החלפה',      emoji: '👕', color: '#e84393', hint: '2 סטים' },
  { key: 'comforter',  label: 'חפץ מעבר',        emoji: '🧸', color: '#ff6f91', hint: 'במידה ומשתמש' },
  { key: 'thermometer', label: 'מד חום קשיח',    emoji: '🌡️', color: '#00a8cc' },
  // Carried over from the board's old list — the gan uses them and dropping
  // them would lose the words the staff already type.
  { key: 'tetra',      label: 'טטרה',            emoji: '🧺', color: '#06d6a0' },
  { key: 'bibs',       label: 'סינרים',          emoji: '🍽️', color: '#f78fb3' },
  { key: 'socks',      label: 'גרביים',          emoji: '🧦', color: '#4b7bec' },
];

const CATALOGUE_NOTE = 'יש לציין שם על כל הפריטים';

const BY_KEY = new Map(CATALOGUE.map((i) => [i.key, i]));

/** The catalogue entry, or a stand-in for something the gan typed itself. */
function itemFor(key, label = '') {
  const known = BY_KEY.get(key);
  if (known) return known;
  return { key, label: label || key, emoji: '📌', color: '#64748b' };
}

/**
 * Fill a stored row out for display: the label, emoji and colour come from the
 * catalogue at READ time, so correcting a label fixes every child at once
 * rather than only the ones marked after the correction.
 */
function decorate(stored) {
  const item = itemFor(stored.key, stored.label);
  return {
    key: stored.key,
    label: stored.label || item.label,
    emoji: item.emoji,
    color: item.color,
    hint: item.hint || '',
    note: stored.note || '',
    marked_at: stored.marked_at,
    marked_by_name: stored.marked_by_name || '',
  };
}

/**
 * Clean a requested set of items.
 *
 * Deduplicated by key, because the screen sends what is ticked and a child can
 * be short of nappies once. An item already marked KEEPS its original
 * timestamp — re-saving the same list must not make a three-week-old request
 * look like it was raised this morning, which is exactly how a forgotten item
 * stays forgotten.
 */
function mergeMissing(existing, requested, actor = {}) {
  const previous = new Map((existing || []).map((m) => [m.key, m]));
  const seen = new Set();
  const out = [];

  for (const raw of requested || []) {
    const key = String(raw?.key || raw || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const before = previous.get(key);
    out.push({
      key,
      label: String(raw?.label || before?.label || '').trim(),
      note: String(raw?.note ?? before?.note ?? '').trim(),
      marked_at: before?.marked_at || new Date(),
      marked_by: before?.marked_by ?? (actor.id || null),
      marked_by_name: before?.marked_by_name || actor.full_name || '',
    });
  }

  // Oldest first: the item that has been outstanding longest is the one being
  // forgotten, so it belongs at the top of what anybody reads.
  out.sort((a, b) => new Date(a.marked_at) - new Date(b.marked_at));
  return out;
}

module.exports = { CATALOGUE, CATALOGUE_NOTE, itemFor, decorate, mergeMissing };
