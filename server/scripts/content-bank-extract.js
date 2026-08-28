#!/usr/bin/env node
/**
 * Build the content bank seed from real yearly gantt workbooks.
 *
 *   node server/scripts/content-bank-extract.js <file.xlsx> [more.xlsx ...]
 *   node server/scripts/content-bank-extract.js ~/Downloads/*.xlsx
 *
 * Writes server/src/content-bank/seed.json.
 *
 * Why a script and not a one-off paste: the gan has nineteen of these
 * workbooks on Drive — every branch, every age group, back to 2020 — and they
 * keep being written. The bank has to be re-buildable from whatever set of
 * files is on disk today, or it is a snapshot that rots.
 *
 * The workbooks are hand-kept, so nothing here may assume a clean grid. What
 * IS stable across all of them, and is the only thing relied on:
 *
 *   - one sheet per month
 *   - column B holds the row label: מפגש / פעילות / יצירה / סיפור / שונות
 *   - a row whose column B is "תוכן" is a week header, and columns C.. are its
 *     dates
 *   - column A carries the week's theme, on the first row of the week's block
 *
 * Everything else (merged cells, blank weeks, trailing empty blocks, a sheet
 * for a month that never happened) is noise and is dropped.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const XLSX = require('xlsx');

// The five row labels the gan actually writes, mapped onto the gantt's own row
// keys so a bank item can be dropped straight into the matching row.
const CATEGORIES = {
  'מפגש': 'meeting',
  'פעילות': 'activity',
  'יצירה': 'creation',
  'סיפור': 'story',
  'שונות': 'misc',

  // משה דיין writes its craft as two learning stations, "מוקד 1" / "מוקד 2",
  // where the other branches write "יצירה". Dropping the label because it is
  // unfamiliar threw away 797 cells — and reading them settles what they are:
  // גואש, בצק, חימר, גזירה, צבעי ידיים, קצף. That is the יצירה row under
  // another name, so it is banked as one rather than as a sixth category no
  // other gan has a row for.
  'מוקד 1': 'creation',
  'מוקד 2': 'creation',
  'מוקד': 'creation',
};

const WEEK_HEADER = 'תוכן';

// The craft-station table's own rows, and the subject they are banked under —
// the heading the gan itself puts above that table.
const STATION_LABELS = new Set(['מוקד 1', 'מוקד 2', 'מוקד']);
const STATION_THEME = 'התנסות בחומרים';

// Room names, which are the station table's left column — never a subject.
const ROOMS = new Set(['תינוקייה', 'תינוקיה', 'צעירים', 'בוגרים']);

/**
 * Theme names as typed by hand over six years: "שבוע 2 ראש השנה",
 * "שבווע 20 ט"ו בשבט" (sic), "שבוע נושא הגינה", "שבוע פסח".
 * Strip the scaffolding and keep the subject, which is the thing a gananet
 * searches by.
 */
function normalizeTheme(raw) {
  if (!raw) return '';
  let t = String(raw).replace(/\s+/g, ' ').trim();
  t = t.replace(/^נושא\s*[-:־]?\s*/u, '');   // "נושא שבועי חנוכה" / "נושא הגינה"

  // "שבוע 4 סוכות", "שבווע 20 ט"ו בשבט" (sic), "שבועי- יום העצמאות",
  // "שבועי: קיץ" — every branch scaffolds the cell differently and none of it
  // is the subject.
  //
  // The lookahead is load-bearing twice over: without it "שבועות" — the
  // festival, a subject in its own right — is eaten down to "ת", and
  // "שבועי" (the blank template's own heading) must reduce to nothing so the
  // caller can drop it.
  t = t.replace(/^שבו{1,2}עי?(?=[\s\d\-:־]|$)[\s\-:־]*/u, '');
  t = t.replace(/^\d+\s*[-:־]?\s*/u, '');    // the week number
  // Again, because "נושא שבועי נושא הגינה" is a real cell and one pass leaves
  // the second "נושא" standing as part of the subject name.
  t = t.replace(/^נושא\s*[-:־]?\s*/u, '');
  t = t.replace(/["'׳״]/gu, '"');            // ט"ו בשבט spelled four ways
  return t.trim();
}

/**
 * The same subject, spelled differently by different branches and years.
 *
 * Keys are POST-normalisation, so they carry the ASCII quote normalizeTheme
 * leaves behind. Without this the picker offers "ט"ו בשבט", "טו בשבט" and
 * "טוב בשבט" as three separate subjects, each holding a third of the ideas —
 * which is worse than not grouping at all, because it looks complete.
 */
const THEME_ALIASES = {
  'טו בשבט': 'ט"ו בשבט',
  'טוב בשבט': 'ט"ו בשבט',            // a real typo, in a real workbook
  'גינה': 'הגינה',
  'הספר': 'שבוע הספר',
  'ספר': 'שבוע הספר',
  'לג בעומר': 'ל"ג בעומר',
  'עצמאות': 'יום העצמאות',
  'חושים': 'החושים',
  'חג שבועות': 'שבועות',
  'חיים נחמן ביאליק': 'ביאליק',
  'הגוף שלי': 'אני וגופי',
  ';הירות בדרכים': 'זהירות בדרכים',  // ז typed on an English layout
};

function canonicalTheme(t) {
  return THEME_ALIASES[t] || t;
}

/**
 * Column A does not always hold a subject. On some sheets it holds the room —
 * "בוגרים", "תינוקייה" — and on the unused week blocks at the foot of a sheet
 * it holds the blank template's own heading. Neither is something a gananet
 * would ever search by, and both looked like real subjects in the picker.
 */
const NOT_A_THEME = new Set([
  '', 'שבועי', 'שבוע', 'תוכן', 'נושא',
  'תינוקייה', 'תינוקיה', 'צעירים', 'בוגרים',
]);

/**
 * What a gananet has to physically put on the table to run this.
 *
 * Derived from the text rather than stored, because six years of workbooks
 * never recorded materials — they were in the storeroom and in her head. The
 * value of writing them down is that a gan that does NOT have them can be told
 * so before the week starts, instead of on the morning of.
 *
 * Keyword -> materials. Longest match wins so "צבעי אצבעות" does not merely
 * match "צבע".
 */
const MATERIALS = [
  ['צבעי אצבעות', ['צבעי אצבעות', 'בריסטול', 'סינרים', 'מגבונים']],
  ['גואש', ['צבעי גואש', 'מכחולים', 'צלחות ערבוב', 'בריסטול', 'סינרים']],
  ['בצק', ['בצק משחק', 'משטחי עבודה', 'מערוכים', 'קופיצים']],
  ['פלסטלינה', ['פלסטלינה', 'משטחי עבודה']],
  ['קולאז', ['דפי בריסטול', 'דבק', 'מספריים', 'חומרי גזירה']],
  ['הדבק', ['דבק', 'בריסטול', 'מגזרות']],
  ['מגזרות', ['מגזרות מוכנות', 'דבק', 'בריסטול']],
  ['גזיר', ['מספריים לילדים', 'דפי גזירה', 'דבק']],
  ['צביעה', ['צבעים', 'מכחולים', 'דפי צביעה']],
  ['ציור', ['צבעים', 'דפי ציור', 'טושים']],
  ['קצף', ['קצף גילוח', 'משטח רחיץ', 'סינרים']],
  ['חול', ['חול', 'מגש חושים', 'כלי חפירה']],
  ['מים', ['מגש מים', 'כלי מדידה', 'סינרים']],
  ['אפי', ['חומרי אפייה', 'קערות', 'תבניות', 'סינרים']],
  ['עוגה', ['חומרי אפייה', 'קערות', 'תבניות']],
  ['בישול', ['חומרי בישול', 'קערות', 'כלי מטבח']],
  ['טעימ', ['מזון לטעימה', 'צלחות חד-פעמיות', 'מפיות']],
  ['נטעם', ['מזון לטעימה', 'צלחות חד-פעמיות', 'מפיות']],
  ['נריח', ['פריטי ריח', 'מגש חושים']],
  ['שתיל', ['שתילים', 'אדמה', 'עציצים', 'כלי גינון']],
  ['זריע', ['זרעים', 'אדמה', 'כוסות שתילה']],
  ['נטיע', ['שתילים', 'אדמה', 'כלי גינון']],
  ['תנועה', ['רמקול', 'מוזיקה', 'מזרנים']],
  ['ריקוד', ['רמקול', 'מוזיקה']],
  ['שיר', ['רמקול', 'מוזיקה']],
  ['סיפור', ['ספר', 'שטיח מפגש']],
  ['כרטיס ברכה', ['בריסטול צבעוני', 'טושים', 'מדבקות', 'דבק']],
  ['נר', ['נרות', 'חנוכייה', 'גפרורים']],
  ['חנוכי', ['חנוכייה', 'נרות']],
  ['סביבון', ['סביבונים']],
  ['שופר', ['שופר']],
  ['דגל', ['דגלים', 'מקלות עץ', 'בריסטול']],
  ['תחפוש', ['תחפושות', 'אביזרי הצגה']],
  ['מסכ', ['בסיסי מסכה', 'גומיות', 'חומרי קישוט']],
  ['פאזל', ['פאזלים']],
  ['משחק', ['משחקי קופסה', 'אביזרי משחק']],
  ['ניסוי', ['כלי ניסוי', 'מגשים', 'סינרים']],
  ['צילום', ['מצלמה', 'מדפסת תמונות']],
];

function materialsFor(text) {
  const t = String(text || '');
  const found = new Set();
  for (const [needle, items] of MATERIALS) {
    if (t.includes(needle)) items.forEach(i => found.add(i));
  }
  return [...found];
}

/** תינוקייה / צעירים / בוגרים, off the workbook's own file name. */
function ageGroupOf(fileName) {
  if (/תינוק/u.test(fileName)) return 'תינוקייה';
  if (/צעיר/u.test(fileName)) return 'צעירים';
  if (/בוגר/u.test(fileName)) return 'בוגרים';
  return null;
}

/** The gan the workbook came from, for provenance only. */
function branchOf(fileName) {
  const m = fileName.match(/(קפלן|משה דיין|הרצליה|תל אביב|שאול המלך)/u);
  return m ? m[1] : null;
}

/**
 * A cell is worth banking only if it is an idea. Dates, "הגן סגור", a lone
 * day name and the like are administration, and putting them in the bank
 * means a gananet searching "סוכות" is offered "הגן סגור".
 */
const NOT_CONTENT = [
  /^חופש/u, /הגן סגור/u, /^אין /u, /^-+$/u, /^\d+$/u,
  /^יום [א-ו]'?$/u,
];

/**
 * Named children, which must never reach the bank.
 *
 * The שונות row is where the gan writes who is אבא/אמא של שבת that week, by
 * first name and sometimes by surname initial — "בוגרים : ריין+ליה הרפז",
 * "תינוקיה : גפן .ס. + שקד .ש.". They are four-year-olds, and this bank ships
 * to every customer of the platform. A "content bank" that carries another
 * gan's children's names is not a content problem, it is a data-protection
 * incident, and it would be found by the person it names.
 *
 * Matched by the SHAPE the gan writes them in — a room or a role, then a colon
 * — rather than by trying to recognise names, which cannot be done reliably
 * and fails towards leaking.
 */
const PERSONAL = [
  /^(תינוקי[יה]?ה|צעירים|בוגרים)\s*[:：+]/u,
  /(אבא|אמא|ילד|ילדת|ילדי)\s+של\s+שבת/u,
  // Every birthday line in every workbook is "יום הולדת ל<שם של ילד>". There is
  // no version of it that is not a named four-year-old, so the whole phrase
  // goes — not just the colon form. 109 of them were in the first build.
  /יום הולדת/u,
  /מזל טוב/u,
];

function isContent(text) {
  const t = String(text || '').trim();
  if (t.length < 2 || t.length > 200) return false;
  // Must contain an actual letter. NOT \W — in JavaScript \w is ASCII-only, so
  // \W matches every Hebrew character and a "reject non-word" test silently
  // throws away the entire bank.
  if (!/\p{L}/u.test(t)) return false;
  if (PERSONAL.some(re => re.test(t))) return false;
  return !NOT_CONTENT.some(re => re.test(t));
}

function cellText(ws, r, c) {
  const ref = XLSX.utils.encode_cell({ r: r - 1, c: c - 1 });
  const cell = ws[ref];
  if (!cell || cell.v == null) return '';
  return String(cell.v)
    // Includes the non-breaking spaces a paste from Word leaves behind, which
    // are invisible and made "ציור + בצק" bank three times as three ideas.
    .replace(/[\s\u00a0\u200f\u200e]+/gu, ' ')
    .replace(/\s*([+/])\s*/gu, ' $1 ')
    .trim();
}

function parseWorkbook(filePath) {
  const fileName = path.basename(filePath);
  const wb = XLSX.readFile(filePath, { cellDates: false });
  const ageGroup = ageGroupOf(fileName);
  const branch = branchOf(fileName);
  const out = [];

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws || !ws['!ref']) continue;
    const range = XLSX.utils.decode_range(ws['!ref']);
    const lastRow = Math.min(range.e.r + 1, 400);
    const lastCol = Math.min(range.e.c + 1, 12);

    let theme = '';
    let group = '';   // the room the התנסות בחומרים table is currently on

    for (let r = 1; r <= lastRow; r += 1) {
      const b = cellText(ws, r, 2);
      if (b === WEEK_HEADER) continue;      // week/date header row

      const a = cellText(ws, r, 1);
      // The room names only ever appear as the left column of the התנסות
      // בחומרים table, so they are its group rather than a subject.
      if (ROOMS.has(a)) group = a;

      const key = CATEGORIES[b];
      if (!key) continue;

      const isStation = STATION_LABELS.has(b);

      if (!isStation) {
        if (a) theme = canonicalTheme(normalizeTheme(a));
        if (NOT_A_THEME.has(theme)) continue;
      }

      // "מוקד 1" / "מוקד 2" are not part of the weekly plan at all. They are a
      // second table further down the sheet — "התנסות בחומרים - תוכנית שבועית"
      // — a standing rota of craft stations per room, with no subject attached
      // to any of it. Filing them under whatever subject happened to be in
      // scope would attach גזירת פלסטלינה to פסח for no reason, and dropping
      // them threw away 797 cells of exactly the row the bank is thinnest on.
      // So they are banked under the gan's own name for that table, and the
      // room in its left column is a better age group than the file name.
      const rowTheme = isStation ? STATION_THEME : theme;
      const rowAge = isStation ? (group || ageGroup) : ageGroup;

      for (let c = 3; c <= lastCol; c += 1) {
        const text = cellText(ws, r, c);
        if (!isContent(text)) continue;
        out.push({
          theme: rowTheme,
          category: key,
          title: text,
          age_group: rowAge,
          branch,
          month_sheet: sheetName.trim(),
          source: fileName,
          materials: materialsFor(text),
        });
      }
    }
  }
  return out;
}

/**
 * The same idea appears in every branch and every year — that is the point,
 * it is what the gan actually repeats. Bank it once, and count the repeats:
 * an idea written down eleven times over six years is the one to offer first.
 */
function dedupe(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = `${row.theme} ${row.category} ${row.title}`;
    const seen = byKey.get(key);
    if (!seen) {
      byKey.set(key, { ...row, uses: 1, age_groups: row.age_group ? [row.age_group] : [], sources: [row.source] });
      continue;
    }
    seen.uses += 1;
    if (row.age_group && !seen.age_groups.includes(row.age_group)) seen.age_groups.push(row.age_group);
    if (!seen.sources.includes(row.source)) seen.sources.push(row.source);
  }
  return [...byKey.values()].map(({ age_group: _a, branch: _b, source: _s, month_sheet: _m, ...keep }) => keep);
}

function main() {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('usage: node server/scripts/content-bank-extract.js <gantt.xlsx> [...]');
    process.exit(1);
  }

  let all = [];
  // The same workbook downloaded twice arrives as "... (1).xlsx". Parsing both
  // would not add an idea — it would double its `uses`, and `uses` is what
  // decides which idea is offered first. An idea must not look established
  // because somebody clicked download twice.
  const seenFiles = new Map();

  for (const f of files) {
    if (!fs.existsSync(f)) { console.error(`דילוג, לא נמצא: ${f}`); continue; }
    try {
      const hash = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
      if (seenFiles.has(hash)) {
        console.log(`${path.basename(f)}: עותק זהה של ${seenFiles.get(hash)} — דילוג`);
        continue;
      }
      seenFiles.set(hash, path.basename(f));

      const rows = parseWorkbook(f);
      console.log(`${path.basename(f)}: ${rows.length} רשומות`);
      all = all.concat(rows);
    } catch (err) {
      console.error(`שגיאה בקריאת ${path.basename(f)}: ${err.message}`);
    }
  }

  const items = dedupe(all).sort((x, y) => y.uses - x.uses || x.theme.localeCompare(y.theme, 'he'));
  const themes = [...new Set(items.map(i => i.theme))].sort((a, b) => a.localeCompare(b, 'he'));

  // NOT src/data/ — .gitignore excludes every `data/` directory, so the bank
  // would be built locally, work locally, and simply not exist on the server.
  const outPath = path.join(__dirname, '..', 'src', 'content-bank', 'seed.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify({ generated_from: [...seenFiles.values()], themes, items }, null, 1)}\n`);

  console.log(`\nסה"כ ${all.length} רשומות -> ${items.length} פריטים ייחודיים, ${themes.length} נושאים`);
  console.log(`נכתב: ${path.relative(process.cwd(), outPath)}`);
}

if (require.main === module) main();

module.exports = { parseWorkbook, dedupe, normalizeTheme, canonicalTheme, materialsFor, isContent };
