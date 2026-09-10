#!/usr/bin/env node
/**
 * A one-way ratchet on hand-written colour in the client.
 *
 * The staff app carries hundreds of hex literals typed straight into
 * components, which is the direct cause of six stat tiles on one screen in six
 * different colours, and of a table that styles itself differently on every
 * screen it appears on. They come out screen by screen, over a long time — and
 * anything that comes out slowly goes back in quietly unless something counts.
 *
 * So: count them, keep the number in docs/design/hex-budget.json, and fail
 * when it grows. Lowering it is the point; the test prints the new number to
 * write down whenever it drops.
 *
 * theme/tokens.js is exempt — it is the file whose job is to hold colours. So
 * is the parent portal, which was designed separately and deliberately and
 * carries its own theme factory.
 *
 *   node scripts/design-hex-budget.test.js
 */
const fs = require('fs');
const path = require('path');

const CLIENT_SRC = path.join(__dirname, '..', '..', 'client', 'src');
const BUDGET_FILE = path.join(__dirname, '..', '..', 'docs', 'design', 'hex-budget.json');

const EXEMPT = [
  path.join('theme', 'tokens.js'),
  path.join('theme', 'parentTheme.js'),
  path.join('components', 'parent-portal') + path.sep,
];

const COLOUR = /#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(/g;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(jsx?|css)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function main() {
  console.log('=== תקציב צבעים קשיחים בצד הלקוח ===\n');

  const files = walk(CLIENT_SRC).filter((f) => {
    const rel = path.relative(CLIENT_SRC, f);
    return !EXEMPT.some((e) => rel === e || rel.startsWith(e));
  });

  const perFile = [];
  let total = 0;
  for (const f of files) {
    const n = (fs.readFileSync(f, 'utf8').match(COLOUR) || []).length;
    if (n > 0) { perFile.push([path.relative(CLIENT_SRC, f), n]); total += n; }
  }
  perFile.sort((a, b) => b[1] - a[1]);

  if (!fs.existsSync(BUDGET_FILE)) {
    console.log(`נמצאו ${total} צבעים קשיחים ב-${perFile.length} קבצים.`);
    console.log(`\n❌ אין קובץ תקציב. צור ${path.relative(process.cwd(), BUDGET_FILE)} עם total: ${total}`);
    process.exit(1);
  }

  /**
   * A file that uses COLOR without importing it.
   *
   * This has now bitten twice, and it is nastier than it sounds: it is a
   * runtime ReferenceError, not a syntax one, so `vite build` passes happily
   * and the screen goes blank the first time somebody opens it. Both times the
   * check that missed it counted USAGES rather than the import.
   */
  console.log('\nכל קובץ שמשתמש באסימונים גם מייבא אותם:');
  /**
   * Comments do not execute, and a comment that explains WHY a token exists is
   * exactly the comment worth writing — so `// COLOR.row.attention was defined
   * and never used` must not be read as a use. Stripping them first keeps the
   * check about code; without it the fix is to delete the explanation, which is
   * the wrong thing to teach.
   */
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const missingImport = files.filter((f) => {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    return /\bCOLOR\./.test(src) && !/import\s*\{[^}]*\bCOLOR\b[^}]*\}/.test(src);
  });
  if (missingImport.length) {
    for (const f of missingImport) console.log(`  ❌ ${path.relative(CLIENT_SRC, f)}`);
    console.log('\n❌ ReferenceError בזמן ריצה — הבנייה עוברת והמסך יוצא לבן.');
    process.exit(1);
  }
  console.log('  ✅ אין קובץ כזה');

  /**
   * `${COLOR.x}` written inside a string that is not a template literal.
   *
   * The characters ship verbatim, CSS drops the declaration, and the element
   * silently loses its colour — no error anywhere, and `vite build` is happy.
   * It happens when colours are swapped inside a file that mixes JSX props
   * (plain strings) with a printed stylesheet (a template literal), which is
   * every screen carrying a print or Excel export. Nine got through in one
   * pass, and the bundle was the only place they were visible.
   *
   * Matched narrowly: a quoted string whose ENTIRE content is one COLOR
   * token. A regex cannot tell a quote inside a template literal from one
   * outside it without parsing the language, and a check that cries wolf gets
   * switched off — so this only catches the exact shape the mistake takes, and
   * says nothing about anything else. `class="${trClass}"` inside a template
   * is ordinary and must not trip it.
   */
  console.log('\nאין תחביר תבנית בתוך מחרוזת רגילה:');
  const badInterp = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/(['"])\$\{\s*COLOR\.[\w.]+\s*\}\1/g)) {
      badInterp.push(`${path.relative(CLIENT_SRC, f)}:${src.slice(0, m.index).split('\n').length}  ${m[0].slice(0, 60)}`);
    }
  }
  if (badInterp.length) {
    for (const b of badInterp.slice(0, 10)) console.log(`  ❌ ${b}`);
    console.log('\n❌ הצבע לא יוצא — CSS מתעלם מההצהרה ואין שגיאה בשום מקום.');
    process.exit(1);
  }
  console.log('  ✅ אין');

  /**
   * The orange that failed, by name, anywhere in the client.
   *
   * design-tokens.test.js asserts `primary.main !== '#f59e0b'`, which only
   * guards the token — and the colour walked straight back in through a
   * component, hand-typed on five dashboard cards and on index.html's
   * theme-color. A rule that only protects the place you took it out of is not
   * a rule.
   */
  console.log('\nהכתום שנכשל בניגודיות לא חזר בשום צורה:');
  const BANNED = ['#f59e0b', '#F59E0B'];
  const offenders = [];
  for (const f of [...files, path.join(__dirname, '..', '..', 'client', 'index.html')]) {
    if (!fs.existsSync(f)) continue;
    const src = fs.readFileSync(f, 'utf8');
    // tokens.js keeps it deliberately as primary.light / sidebar.marker — fills
    // that never carry text.
    if (f.endsWith(path.join('theme', 'tokens.js'))) continue;
    // Comments may name the colour — this whole rule exists because of it, and
    // the explanation of why it is banned should not itself be a violation.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/<!--[\s\S]*?-->/g, '');
    if (BANNED.some((b) => code.includes(b))) offenders.push(path.relative(CLIENT_SRC, f));
  }
  if (offenders.length) {
    for (const o of offenders) console.log(`  ❌ ${o}`);
    console.log('\n❌ 2.2:1 מאחורי טקסט לבן. השתמשו ב-primary.main, או ב-primary.light למילוי בלי טקסט.');
    process.exit(1);
  }
  console.log('  ✅ אין');

  const budget = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'));

  console.log(`נמצאו ${total} צבעים קשיחים ב-${perFile.length} קבצים.`);
  console.log(`התקציב הרשום: ${budget.total} (נרשם ${budget.recorded})\n`);
  console.log('עשרת הקבצים הגדולים:');
  for (const [rel, n] of perFile.slice(0, 10)) console.log(`  ${String(n).padStart(4)}  ${rel}`);

  if (total > budget.total) {
    console.log(`\n❌ עלה ב-${total - budget.total}. צבע חדש נכתב ידנית במקום אסימון מ-theme/tokens.js.`);
    process.exit(1);
  }
  if (total < budget.total) {
    console.log(`\n✅ ירד ב-${budget.total - total}. עדכן את docs/design/hex-budget.json ל-${total}.`);
    process.exit(0);
  }
  console.log('\n✅ ללא שינוי.');
  process.exit(0);
}

main();
