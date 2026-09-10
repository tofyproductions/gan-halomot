#!/usr/bin/env node
/**
 * A ceiling on what the browser downloads before it can show anything.
 *
 * The app used to arrive as one 4MB file: opening the dashboard also fetched
 * the payroll table, the Gantt editor, the payslip auditor, a spreadsheet
 * writer, a PDF renderer and a charting library — for a person who might open
 * three screens all week, on a gan's wifi, often on a phone.
 *
 * Splitting it is easy to undo by accident. One static `import` of a heavy
 * library at the top of a file that happens to be on the critical path pulls
 * the whole thing back into the first download, and nothing complains: the
 * build succeeds, the app works, it is just slow again. That is exactly how
 * html2pdf.js — 983KB — came to be imported by a screen that had stopped using
 * it and prints through the browser instead.
 *
 * So: read what index.html actually asks for before first paint, and fail if
 * it grows.
 *
 *   npm --prefix client run build && node scripts/bundle-budget.test.js
 *
 * Fails when there is no build to measure. --allow-missing opts out, loudly.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DIST = path.join(__dirname, '..', '..', 'client', 'dist');
const BUDGET_FILE = path.join(__dirname, '..', '..', 'docs', 'design', 'bundle-budget.json');

let failures = 0;
let checks = 0;
function ok(cond, label, detail = '') {
  checks++;
  if (cond) console.log(`  ✅ ${label}`);
  else { failures++; console.log(`  ❌ ${label}${detail ? `  (${detail})` : ''}`); }
  return !!cond;
}

function main() {
  console.log('=== תקציב הטעינה הראשונה ===\n');

  /**
   * No build, no pass.
   *
   * This used to print a note and exit 0, which is the worst of both: a
   * pipeline whose build step failed or was skipped runs this, sees green, and
   * ships the very regression the file exists to catch — a heavy library back
   * on the critical path, measured by nobody. Skipping has to be asked for out
   * loud.
   */
  const indexHtml = path.join(DIST, 'index.html');
  if (!fs.existsSync(indexHtml)) {
    const skipping = process.argv.includes('--allow-missing');
    console.log('אין build ב-client/dist. הרץ קודם:  npm --prefix client run build');
    if (skipping) {
      console.log('\n⏭️  --allow-missing — מדלג במפורש.\n');
      process.exit(0);
    }
    console.log('\n❌ אין מה למדוד, ולכן אין מה לאשר.');
    console.log('   (להרצה מכוונת בלי build:  node scripts/bundle-budget.test.js --allow-missing)\n');
    process.exit(1);
  }

  const html = fs.readFileSync(indexHtml, 'utf8');
  // Everything the document pulls in before it can paint: the entry script and
  // every module it preloads. A lazily-imported screen is not in here, which is
  // the entire point.
  const files = [...new Set(
    [...html.matchAll(/(?:src|href)="\/assets\/([^"]+\.js)"/g)].map((m) => m[1])
  )];

  let raw = 0;
  let gz = 0;
  const rows = [];
  for (const f of files) {
    const p = path.join(DIST, 'assets', f);
    if (!fs.existsSync(p)) continue;
    const buf = fs.readFileSync(p);
    const g = zlib.gzipSync(buf).length;
    raw += buf.length;
    gz += g;
    rows.push([f, buf.length, g]);
  }
  rows.sort((a, b) => b[1] - a[1]);

  console.log(`הדפדפן מוריד ${rows.length} קבצים לפני שהוא מציג משהו:`);
  for (const [f, r, g] of rows) {
    console.log(`  ${(r / 1024).toFixed(0).padStart(6)} KB  (${(g / 1024).toFixed(0).padStart(4)} דחוס)  ${f}`);
  }

  const budget = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'));
  const gzKB = Math.round(gz / 1024);
  console.log(`\nסך הכול: ${(raw / 1048576).toFixed(2)} MB · ${gzKB} KB דחוס`);
  console.log(`התקציב: ${budget.firstLoadGzipKB} KB דחוס\n`);

  ok(gzKB <= budget.firstLoadGzipKB,
    `הטעינה הראשונה ${gzKB} KB דחוס`,
    `התקציב ${budget.firstLoadGzipKB} — ספרייה כבדה חזרה למסלול הקריטי`);

  /**
   * The three that are only ever needed by somebody doing a specific job:
   * exporting a spreadsheet, rendering a contract, reading a chart. If one of
   * them is preloaded, a static import somewhere put it back.
   */
  for (const heavy of ['vendor-xlsx', 'vendor-pdf', 'vendor-charts']) {
    ok(!files.some((f) => f.startsWith(heavy)),
      `${heavy} לא נטען מראש`,
      'מישהו ייבא אותו סטטית בקובץ שנמצא במסלול הקריטי');
  }

  if (gzKB < budget.firstLoadGzipKB) {
    console.log(`\n✅ ירד ב-${budget.firstLoadGzipKB - gzKB} KB. עדכן את docs/design/bundle-budget.json ל-${gzKB}.`);
  }

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} עברו\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
