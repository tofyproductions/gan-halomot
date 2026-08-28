/**
 * בנק תוכן — the ideas a week of gan is built from, indexed by its subject.
 *
 * A gananet writing next month's work plan is not short of a text box; she is
 * short of "what do we DO for פסח with בוגרים, five days running, without
 * repeating last year". That question has been answered before — in six years
 * of yearly workbooks across every branch — and until now the answer lived in
 * a spreadsheet on a Drive nobody opens mid-week.
 *
 * Two layers, merged on read:
 *
 *   1. the shipped bank — content-bank.seed.json, built by
 *      scripts/content-bank-extract.js from the real workbooks. Same for every
 *      customer, read-only, held in memory. It is the thing being sold.
 *   2. the gan's own — ContentBankItem in the customer's own database: what
 *      they added, and which shipped items they hid.
 *
 * Nothing here writes to the gantt. suggestWeek() proposes; the screen decides.
 */

const { ContentBankItem } = require('../models');
const seed = require('../content-bank/seed.json');

const CATEGORY_LABELS = {
  meeting: 'מפגש',
  activity: 'פעילות',
  creation: 'הנגשת חומרים',
  story: 'סיפור',
  misc: 'שונות',
};

const CATEGORY_ORDER = ['meeting', 'activity', 'creation', 'story', 'misc'];

/**
 * A stable id for a shipped item.
 *
 * It has to survive a rebuild of the seed file, because a gan may have hidden
 * an item and a rebuild that renumbers everything would silently un-hide it —
 * or worse, hide a different one. So it is derived from the content itself,
 * not from the item's position in the file.
 */
function seedId(item) {
  const key = `${item.theme}|${item.category}|${item.title}`;
  let h = 5381;
  for (let i = 0; i < key.length; i += 1) h = ((h * 33) ^ key.charCodeAt(i)) >>> 0;
  return `s${h.toString(36)}`;
}

// Frozen at require time. The seed is a build artefact, not state.
const SEED_ITEMS = Object.freeze(seed.items.map(i => Object.freeze({
  id: seedId(i),
  theme: i.theme,
  category: i.category,
  title: i.title,
  materials: i.materials || [],
  age_groups: i.age_groups || [],
  uses: i.uses || 1,
  origin: 'seed',
})));

const SEED_THEMES = Object.freeze([...seed.themes]);

/**
 * Is this the id of a shipped item rather than one of the gan's own?
 *
 * Shipped ids are the content hash prefixed with "s"; the gan's own are Mongo
 * ObjectIds, which are 24 hex characters. Testing only for the leading "s"
 * would have been enough by luck — no ObjectId starts with a letter outside
 * a-f — but "starts with s" is not a statement about what the id IS, and the
 * two id spaces decide whether a delete removes a row or hides shipped content.
 */
function isSeedId(id) {
  return typeof id === 'string' && /^s[0-9a-z]+$/.test(id) && !/^[0-9a-f]{24}$/.test(id);
}

/** Loose Hebrew match — no stemming, just "does the typed text appear". */
function matches(item, q) {
  if (!q) return true;
  const needle = q.trim();
  if (!needle) return true;
  return item.title.includes(needle)
    || item.theme.includes(needle)
    || (item.materials || []).some(m => m.includes(needle));
}

function suitsAge(item, ageGroup) {
  if (!ageGroup) return true;
  const groups = item.age_groups || [];
  // An item recorded without an age group came from a workbook that covered
  // the whole gan. That is not "unsuitable" — it is "not narrowed", and
  // filtering it out empties the bank for a room that has a category set.
  return groups.length === 0 || groups.includes(ageGroup);
}

/**
 * Shipped bank + this gan's rows, minus what it hid. Pure, so the merge rule
 * can be tested without standing up a database.
 */
function mergeItems(customRows, seedItems = SEED_ITEMS) {
  const custom = customRows || [];

  const hidden = new Set(
    custom.filter(c => c.hides_seed_id).map(c => c.hides_seed_id),
  );

  const own = custom
    .filter(c => !c.hides_seed_id)
    .map(c => ({
      id: String(c._id || c.id),
      theme: c.theme,
      category: c.category,
      title: c.title,
      notes: c.notes || '',
      materials: c.materials || [],
      age_groups: c.age_groups || [],
      uses: 1,
      origin: 'own',
    }));

  return [...seedItems.filter(i => !hidden.has(i.id)), ...own];
}

/** Everything the gan can see, shipped + own, minus what it hid. */
async function allItems() {
  return mergeItems(await ContentBankItem.find({}).lean());
}

/** The subject list for the picker: shipped themes plus anything the gan added. */
async function themes() {
  const items = await allItems();
  const counts = new Map();
  for (const i of items) counts.set(i.theme, (counts.get(i.theme) || 0) + 1);
  return [...counts.entries()]
    .map(([theme, count]) => ({ theme, count }))
    .sort((a, b) => a.theme.localeCompare(b.theme, 'he'));
}

/**
 * The bank for one subject, grouped by gantt row.
 * Most-used first — an idea written down in nine different years is the one a
 * gananet wants offered before the one written once.
 */
function browseFrom(all, { theme, q, ageGroup } = {}) {
  const items = all
    .filter(i => (!theme || i.theme === theme) && matches(i, q) && suitsAge(i, ageGroup));

  const groups = CATEGORY_ORDER.map(category => ({
    category,
    label: CATEGORY_LABELS[category],
    items: items
      .filter(i => i.category === category)
      .sort((a, b) => b.uses - a.uses || a.title.localeCompare(b.title, 'he')),
  }));

  return { total: items.length, groups };
}

async function browse(opts = {}) {
  return browseFrom(await allItems(), opts);
}

/**
 * A proposed week: one idea per row per working day, for a chosen subject.
 *
 * Deliberately NOT random. A gananet who presses the button twice and gets a
 * different week both times cannot tell whether she is looking at a
 * suggestion or at noise, so the order is the bank's own order — most-used
 * first — and the only variation is `offset`, which is what "הצע אחרת" moves.
 *
 * Returns cells keyed exactly like GanttMonth.weeks[].cells so the client can
 * drop the result straight in.
 *
 * @param {number} days  working days to fill (5 = Sun–Thu; Friday is קבלת שבת
 *                       and is never proposed over)
 */
function suggestFrom(all, { theme, ageGroup, days = 5, offset = 0, rows } = {}) {
  if (!theme) throw new Error('יש לבחור נושא');

  const wanted = (rows && rows.length ? rows : CATEGORY_ORDER)
    .filter(r => CATEGORY_ORDER.includes(r));

  const { groups } = browseFrom(all, { theme, ageGroup });
  const byCategory = new Map(groups.map(g => [g.category, g.items]));

  const cells = [];
  const thin = [];

  for (const category of wanted) {
    const pool = byCategory.get(category) || [];
    if (!pool.length) { thin.push(CATEGORY_LABELS[category]); continue; }

    // Never the same idea twice in one week. A row filled by wrapping round a
    // short pool reads as "the system has nothing here" — five identical boxes
    // in שונות is worse than one filled box and four she writes herself. So a
    // thin row is filled as far as it honestly goes and then reported, and the
    // remaining boxes are simply left for her.
    const take = Math.min(days, pool.length);
    if (take < days) thin.push(CATEGORY_LABELS[category]);

    for (let d = 0; d < take; d += 1) {
      const item = pool[(offset + d) % pool.length];
      cells.push({
        row_key: category,
        day_index: d,
        content: item.title,
        item_id: item.id,
        materials: item.materials,
      });
    }
  }

  return {
    theme,
    cells,
    // Everything the gan has to have on hand for the whole week, once each.
    // This is the list that answers "do we own this, and if not, buy it".
    materials: [...new Set(cells.flatMap(c => c.materials))].sort((a, b) => a.localeCompare(b, 'he')),
    thin_rows: [...new Set(thin)],
  };
}

async function suggestWeek(opts = {}) {
  return suggestFrom(await allItems(), opts);
}

module.exports = {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  SEED_THEMES,
  SEED_ITEMS,
  seedId,
  isSeedId,
  mergeItems,
  browseFrom,
  suggestFrom,
  allItems,
  themes,
  browse,
  suggestWeek,
};
