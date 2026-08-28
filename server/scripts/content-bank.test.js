#!/usr/bin/env node
/**
 * בנק תוכן — the extraction, the merge, and the proposed week.
 *
 * Three things here are worth proving, and each of them has already been wrong
 * once in the writing of this feature:
 *
 *   1. The extractor keeps Hebrew. It did not: the "is this a real idea or
 *      administrative noise" filter used /^\W+$/, and JavaScript's \w is
 *      ASCII-only — so every Hebrew string is "non-word", and the bank built
 *      from 883 rows came out with three items in it. The failure is silent:
 *      the script reports success and writes a valid, nearly empty file.
 *
 *   2. A theme name survives normalisation. "שבוע 4 סוכות" must lose its
 *      scaffolding and "שבועות" — a festival, a subject in its own right —
 *      must not, which a greedy prefix strip turned into the single letter "ת".
 *
 *   3. A gan hiding a shipped item hides that one, permanently, across a
 *      rebuild of the seed file. Ids derived from position in the file would
 *      re-point at a different item the next time the workbooks are re-read.
 *
 *   node scripts/content-bank.test.js
 */

const {
  normalizeTheme, canonicalTheme, isContent, materialsFor, dedupe,
} = require('./content-bank-extract');
const bank = require('../src/services/contentBank.service');

let failures = 0;
const ok = (cond, label) => { console.log(`  ${cond ? '✅' : '❌'} ${label}`); if (!cond) failures++; };
const eq = (a, b, label) => {
  const good = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  ${good ? '✅' : '❌'} ${label}${good ? '' : `  (קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)})`}`);
  if (!good) failures++;
};

console.log('\n🔤  חילוץ מהגאנטים\n');
{
  // The regression. Every one of these is a real cell from the workbooks.
  ok(isContent('הכירות עם הצוות והחברים'), 'טקסט עברי נשמר');
  ok(isContent('תפוח בדבש'), 'טקסט עברי קצר נשמר');
  ok(isContent('ט"ו בשבט'), 'טקסט עם גרשיים נשמר');

  // Administration, not ideas.
  ok(!isContent('חופשת ראש השנה'), 'חופשה אינה פעילות');
  ok(!isContent('יום הכיפורים, הגן סגור'), 'שורה שמכילה "הגן סגור" נפסלת');

  // Named children. The שונות row records who is אבא/אמא של שבת, and this bank
  // ships to every customer — one leaked name is one too many.
  ok(!isContent('בוגרים : ריין+ליה הרפז'), 'שמות ילדים אחרי שם חדר נפסלים');
  ok(!isContent('תינוקיה : גפן .ס. + שקד .ש.'), 'שמות עם ראשי תיבות של משפחה נפסלים');
  ok(!isContent('צעירים:עידן'), 'שם בודד אחרי שם חדר, בלי רווח, נפסל');
  ok(!isContent('אבא של שבת : אביב'), 'אבא של שבת נפסל');
  ok(isContent('קבלת שבת'), 'קבלת שבת עצמה כן נשמרת');
  ok(!isContent('12'), 'מספר בלבד נפסל');
  ok(!isContent('---'), 'קו מפריד נפסל');
  ok(!isContent('א'), 'תו בודד נפסל');
}

console.log('\n📅  שמות נושאים\n');
{
  eq(normalizeTheme('שבוע 4 סוכות '), 'סוכות', 'מספר השבוע יורד');
  eq(normalizeTheme('שבוע 1 הסתגלות\n'), 'הסתגלות', 'ירידת שורה יורדת');
  eq(normalizeTheme('שבווע 20 ט"ו בשבט'), 'ט"ו בשבט', 'שגיאת כתיב ב"שבווע" נסלחת');
  eq(normalizeTheme('שבוע נושא הגינה'), 'הגינה', '"נושא" יורד');
  // The one that broke: a greedy strip ate שבועות down to a single letter.
  eq(normalizeTheme('שבועות'), 'שבועות', 'חג השבועות נשאר חג, לא האות ת');
  eq(canonicalTheme(normalizeTheme('שבוע הספר')), 'שבוע הספר', 'שבוע הספר נשאר שם מלא');
}

console.log('\n🧰  ציוד נדרש\n');
{
  ok(materialsFor('ציור+בצק').includes('בצק משחק'), 'בצק גורר בצק משחק');
  ok(materialsFor('ציור+בצק').includes('דפי ציור'), 'ציור גורר דפי ציור');
  ok(materialsFor('גואש').includes('מכחולים'), 'גואש גורר מכחולים');
  ok(materialsFor('צבעי אצבעות').includes('סינרים'), 'צבעי אצבעות גוררים סינרים');
  eq(materialsFor('הדואר'), [], 'פעילות ללא חומרים אינה ממציאה ציוד');
}

console.log('\n🔁  איחוד כפילויות\n');
{
  const rows = [
    { theme: 'פסח', category: 'story', title: 'הגדה', age_group: 'בוגרים', source: 'א.xlsx', materials: [] },
    { theme: 'פסח', category: 'story', title: 'הגדה', age_group: 'צעירים', source: 'ב.xlsx', materials: [] },
    { theme: 'פסח', category: 'story', title: 'הגדה', age_group: 'בוגרים', source: 'ג.xlsx', materials: [] },
    { theme: 'פסח', category: 'story', title: 'מכות מצרים', age_group: 'בוגרים', source: 'א.xlsx', materials: [] },
  ];
  const out = dedupe(rows);
  eq(out.length, 2, 'שלוש הופעות של אותו רעיון הופכות לפריט אחד');
  const hagada = out.find(o => o.title === 'הגדה');
  eq(hagada.uses, 3, 'מספר ההופעות נספר');
  eq(hagada.age_groups.sort(), ['בוגרים', 'צעירים'], 'שכבות הגיל מתאחדות בלי כפילות');
}

console.log('\n📦  הבנק המצורף\n');
{
  ok(bank.SEED_ITEMS.length > 300, `הבנק מכיל תוכן אמיתי (${bank.SEED_ITEMS.length} פריטים)`);
  ok(bank.SEED_THEMES.length >= 15, `יש מספיק נושאים (${bank.SEED_THEMES.length})`);
  ok(bank.SEED_THEMES.includes('פסח'), 'פסח בבנק');
  // The privacy filter, asserted against the shipped file itself rather than
  // against the function — this is the artefact that actually goes out.
  const named = bank.SEED_ITEMS.filter(i => /^(תינוקי[יה]?ה|צעירים|בוגרים|אבא של שבת|אמא של שבת)\s*[:：]/u.test(i.title));
  eq(named.map(i => i.title), [], 'אין שמות ילדים בבנק המצורף');
  ok(bank.SEED_THEMES.includes('שבועות'), 'שבועות בבנק, ולא "ת"');
  ok(!bank.SEED_THEMES.includes('שבועי'), 'כותרת התבנית הריקה לא נכנסה כנושא');

  const cats = new Set(bank.SEED_ITEMS.map(i => i.category));
  eq([...cats].sort(), ['activity', 'creation', 'meeting', 'misc', 'story'], 'כל חמש השורות מיוצגות');
  ok(bank.SEED_ITEMS.some(i => i.category === 'creation'), 'שורת יצירה קיימת בבנק');

  // Ids come from content, so re-running the extractor cannot re-point a
  // gan's "hide this one" at a different item.
  const first = bank.SEED_ITEMS[0];
  eq(bank.seedId(first), first.id, 'מזהה פריט נגזר מהתוכן ולכן יציב');
  const ids = new Set(bank.SEED_ITEMS.map(i => i.id));
  eq(ids.size, bank.SEED_ITEMS.length, 'אין שני פריטים עם אותו מזהה');
}

console.log('\n🙈  מה שהגן הוסיף ומה שהסתיר\n');
{
  const seedSample = bank.SEED_ITEMS.filter(i => i.theme === 'פסח').slice(0, 3);
  const hidden = seedSample[0];

  const merged = bank.mergeItems([
    { hides_seed_id: hidden.id, theme: 'פסח', category: hidden.category, title: hidden.title },
    { _id: 'own1', theme: 'פסח', category: 'creation', title: 'עוגיות מצה', materials: ['מצות', 'קערות'] },
  ], seedSample);

  ok(!merged.some(i => i.id === hidden.id), 'פריט שהוסתר אינו מוחזר');
  eq(merged.length, seedSample.length - 1 + 1, 'הוסתר אחד, נוסף אחד');
  const own = merged.find(i => i.id === 'own1');
  ok(own && own.origin === 'own', 'פריט של הגן מסומן כשלו');
  ok(bank.SEED_ITEMS.some(i => i.id === hidden.id), 'הבנק המצורף עצמו לא השתנה');
}

console.log('\n🗓️  שבוע מוצע\n');
{
  const all = bank.SEED_ITEMS;
  const week = bank.suggestFrom(all, { theme: 'פסח', days: 5 });

  ok(week.cells.length > 15, `שבוע מלא בתוכן (${week.cells.length} תאים)`);
  ok(week.cells.every(c => c.content && c.content.trim()), 'אין תא ריק');

  // No row may offer the same idea twice in one week. A row filled by wrapping
  // round a two-item pool produced five identical boxes in שונות, which reads
  // as a broken screen rather than as a suggestion.
  for (const key of bank.CATEGORY_ORDER) {
    const inRow = week.cells.filter(c => c.row_key === key).map(c => c.content);
    eq(inRow.length, new Set(inRow).size, `אין חזרה על אותו רעיון בשורת ${bank.CATEGORY_LABELS[key]}`);
    ok(inRow.length <= 5, `לכל היותר חמישה ימים בשורת ${bank.CATEGORY_LABELS[key]}`);
  }

  // A row the bank is thin on is filled as far as it goes and then said so —
  // not padded, and not silently dropped.
  const misc = week.cells.filter(c => c.row_key === 'misc');
  const miscPool = bank.browseFrom(all, { theme: 'פסח' }).groups.find(g => g.category === 'misc').items;
  eq(misc.length, Math.min(5, miscPool.length), 'שורה דלה מתמלאת עד כמה שיש ולא יותר');
  if (miscPool.length < 5) ok(week.thin_rows.includes('שונות'), 'ומדווחת כדלה');
  ok(week.cells.every(c => c.day_index >= 0 && c.day_index <= 4), 'יום שישי לא משובץ — הוא קבלת שבת');
  ok(week.cells.every(c => bank.CATEGORY_ORDER.includes(c.row_key)), 'כל תא יושב על שורה מוכרת של הגאנט');
  ok(week.cells.every(c => c.content.length < 200), 'תוכן התא באורך סביר');

  // The same press twice must give the same week, or a gananet cannot tell a
  // suggestion from noise.
  eq(bank.suggestFrom(all, { theme: 'פסח' }).cells.map(c => c.content),
    week.cells.map(c => c.content), 'אותה בקשה מחזירה אותו שבוע');
  // ...and "הצע אחרת" must actually differ.
  const other = bank.suggestFrom(all, { theme: 'פסח', offset: 1 });
  ok(JSON.stringify(other.cells.map(c => c.content)) !== JSON.stringify(week.cells.map(c => c.content)),
    'הצעה אחרת אכן שונה');

  // The whole week's shopping list, once each.
  eq(week.materials, [...new Set(week.materials)], 'רשימת הציוד ללא כפילויות');
  ok(week.materials.length > 0, 'רשימת ציוד לשבוע שלם אינה ריקה');

  // Only the rows asked for.
  const partial = bank.suggestFrom(all, { theme: 'פסח', rows: ['creation'] });
  ok(partial.cells.every(c => c.row_key === 'creation'), 'בקשה לשורה אחת מחזירה רק אותה');

  // A subject the bank has nothing for must refuse quietly, not crash.
  const empty = bank.suggestFrom(all, { theme: 'נושא שלא קיים' });
  eq(empty.cells, [], 'נושא ריק אינו ממציא תוכן');
  eq(empty.thin_rows.length, bank.CATEGORY_ORDER.length, 'ומדווח שכל השורות ריקות');

  let threw = false;
  try { bank.suggestFrom(all, {}); } catch { threw = true; }
  ok(threw, 'בקשה ללא נושא נדחית');
}

console.log('\n🔎  חיפוש\n');
{
  const all = bank.SEED_ITEMS;
  const byTheme = bank.browseFrom(all, { theme: 'חנוכה' });
  ok(byTheme.total > 0, 'חנוכה מחזיר תוצאות');
  ok(byTheme.groups.every(g => g.items.every(i => i.theme === 'חנוכה')), 'סינון לפי נושא מדויק');

  const byText = bank.browseFrom(all, { q: 'נרות' });
  ok(byText.total > 0, 'חיפוש חופשי בעברית מוצא');

  // A room with an age set must not be shown an empty bank just because the
  // workbook it came from covered the whole gan.
  const aged = bank.browseFrom(all, { theme: 'פסח', ageGroup: 'בוגרים' });
  ok(aged.total > 0, 'חדר עם שכבת גיל עדיין רואה תוכן כללי');
}

console.log(failures === 0
  ? '\n✅  הכל עבר\n'
  : `\n❌  ${failures} בדיקות נכשלו\n`);
process.exit(failures === 0 ? 0 : 1);
