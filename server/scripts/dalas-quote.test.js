#!/usr/bin/env node
/**
 * Reading a DALAS price quote, against the real one.
 *
 * THE FIXTURE IS THE POINT. fixtures/dalas-quote-308710.json is what pdfjs
 * actually produced from the quote the gan was sent on 13/05/2026 — every
 * piece of text with its position, every picture with its box, rounded to a
 * tenth of a point and otherwise untouched. So this asks the only question
 * worth asking of a parser like this: given that document, does it still come
 * back with those 49 products at those prices.
 *
 * THE CHECK THAT MATTERS IS THE TOTAL. Line totals summing to the number the
 * document itself prints as סה"כ לפני is the one assertion here that no amount
 * of column-fiddling can fake: it fails if a row is skipped, if a row is
 * invented, or if any single price is misread. Every specific assertion below
 * it is there to say WHICH of those went wrong when it does.
 *
 *   node scripts/dalas-quote.test.js
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const FIXTURE = path.join(__dirname, 'fixtures', 'dalas-quote-308710.json');
const PARSER = pathToFileURL(
  path.join(__dirname, '..', '..', 'client', 'src', 'components', 'orders', 'dalasQuote.js'),
).href;

let failures = 0;
let checks = 0;
function ok(cond, label, detail = '') {
  checks++;
  if (cond) console.log(`  ✅ ${label}`);
  else { failures++; console.log(`  ❌ ${label}${detail ? `\n     ${detail}` : ''}`); }
}
function eq(actual, expected, label) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), label,
    `קיבלנו ${JSON.stringify(actual)}, ציפינו ${JSON.stringify(expected)}`);
}

async function main() {
  console.log('=== קריאת הצעת מחיר של דאלאס ===\n');

  const { parseQuote, statedSubtotal, toNumber, toProducts } = await import(PARSER);
  const pages = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const rows = parseQuote(pages);

  // ------------------------------------------------------------------ 1 ----
  console.log('1 — כל השורות, ובדיוק הן');
  eq(rows.length, 49, '1a 49 שורות');
  eq(rows.filter(r => r.image).length, 41, '1b 41 מהן עם תמונה');
  eq(rows.map(r => r.line).slice(0, 3), ['001', '002', '003'], '1c ממוספרות מ-001');
  eq(rows[rows.length - 1].line, '049', '1c ועד 049');
  ok(new Set(rows.map(r => r.sku)).size === 49, '1d כל קוד פריט מופיע פעם אחת');

  // ------------------------------------------------------------------ 2 ----
  console.log('\n2 — הסכום, מול מה שהמסמך עצמו מצהיר');
  {
    const stated = statedSubtotal(pages);
    eq(stated, 2630.12, '2a המסמך מצהיר 2,630.12 ש"ח לפני מע"מ');
    const sum = Math.round(rows.reduce((a, r) => a + toNumber(r.total), 0) * 100) / 100;
    eq(sum, stated, '2b סכום 49 השורות שקראנו זהה לו — אגורה באגורה');
  }

  // ------------------------------------------------------------------ 3 ----
  console.log('\n3 — יחידות המידה, שבגללן כל זה התחיל');
  {
    ok(rows.every(r => r.unit), '3a לכל 49 השורות יש יחידת מידה');
    const byUnit = {};
    for (const r of rows) byUnit[r.unit] = (byUnit[r.unit] || 0) + 1;
    ok(Object.keys(byUnit).length >= 8, '3b ויש בהן מגוון אמיתי',
      JSON.stringify(byUnit));
    const carton = rows.find(r => r.sku === '60246');
    eq([carton.unit, carton.price], ['קרטון', '70.000'], '3c 60246 — קרטון ב-70');
    const single = rows.find(r => r.sku === '2101');
    eq([single.unit, single.price], ['יחידה', '3.680'], '3c 2101 — יחידה ב-3.68');
  }

  // ------------------------------------------------------------------ 4 ----
  console.log('\n4 — שמות המוצרים');
  {
    // The last row on every page is the one the footer used to reach into.
    const lastOfPage = ['5015', '9014', '2129', '2384', '2079', '7392', '20361', '22370'];
    const dirty = rows
      .filter(r => lastOfPage.includes(r.sku))
      .filter(r => /סוג משלוח|מספר עוסק|אתר האינטרנט|לרישום|תנאי תשלום|סה[״"]כ/.test(r.name));
    eq(dirty.map(r => r.sku), [], '4a לשורה האחרונה בכל עמוד לא נדבקה הכותרת התחתונה');

    eq(rows.find(r => r.sku === '22370').name, 'תעשייתי סופר רב מגבת 3 *ק"ג *יחידה',
      '4b השורה האחרונה במסמך נקייה');
    ok(rows.every(r => r.name && r.name.length >= 4), '4c לכל מוצר יש שם באורך סביר');
    ok(!rows.some(r => /^\d+$/.test(r.name)), '4d ואף שם אינו מספר בודד שדלף מעמודה אחרת');
  }

  // ------------------------------------------------------------------ 5 ----
  console.log('\n5 — הלוגו אינו מוצר');
  {
    // One picture per page sits in the header at x≈88. If it were ever taken
    // for a product's photo, eight products would wear the DALAS logo.
    const all = pages.flatMap(p => p.images);
    eq(all.length, 49, '5a 49 תמונות במסמך — 41 מוצרים ו-8 לוגואים');
    eq(all.filter(im => im.x > 75).length, 8, '5b שמונה מהן בכותרת, אחת לעמוד');
    ok(rows.every(r => !r.image || r.image.x <= 75), '5c ואף שורה לא קיבלה אחת מהן');
  }

  // ------------------------------------------------------------------ 6 ----
  console.log('\n6 — ההמרה למה שהייבוא מקבל');
  {
    const products = await toProducts(rows, (img) => `data:image/jpeg;base64,FAKE-${img.ref}`);
    eq(products.length, 49, '6a 49 מוצרים');
    eq(products.filter(p => p.image_data).length, 41, '6b 41 עם תמונה');
    const c = products.find(p => p.sku === '60246');
    eq([c.unit, c.price_before_vat], ['קרטון', 70], '6c המחיר הומר למספר');
    ok(products.every(p => p.sku && p.name && p.price_before_vat > 0),
      '6d לכל מוצר יש קוד, שם ומחיר גדול מאפס');
    // The import matches on sku, so a blank one would make a duplicate row on
    // every re-import instead of an update.
    ok(products.every(p => /^\d{3,6}$/.test(p.sku)), '6e וכל קוד פריט תקין');
  }
}

main()
  .then(() => {
    console.log(`\n${failures === 0 ? '✅ הכל עבר' : `❌ ${failures} מתוך ${checks} בדיקות נכשלו`}\n`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error('\n❌ הבדיקה קרסה:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
