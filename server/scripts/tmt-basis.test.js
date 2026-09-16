#!/usr/bin/env node
/**
 * THE תמ"ת TABLE IS MONTHLY. THE FIGURE THE GAN QUOTES IS PER PAYMENT.
 *
 * PricingManager stores every tuition figure as a MONTHLY amount on a
 * twelve-month year, and `installmentOf` multiplies it by 12/11 to produce what
 * a family is actually charged each time. So a tariff that arrives already
 * divided into its eleven payments — which is the form ארגון אמונה sends, and
 * the form the gan commits to in writing — has to be multiplied by 11/12 BEFORE
 * it is pasted into the table.
 *
 * It was pasted in raw once. 4,566 stored as a monthly figure is charged at
 * 4,981: nine percent over the committed price, on every invoice, for every
 * family, with nothing on the screen looking wrong — both numbers are plausible
 * tuition and neither is labelled with its basis.
 *
 * This is the test that would have caught it. It divides the stored tariff back
 * out by the same 12/11 the screen applies and checks it lands on the figures
 * אמונה actually sent. It then checks every subsidised row is that column's
 * תשפ"ו value scaled by the same raise, which is the claim the table's comment
 * makes and the only thing that makes twelve rows derivable from three numbers.
 *
 *   node scripts/tmt-basis.test.js
 *
 * Reads the client source as text rather than importing it: the file is JSX
 * with MUI imports and this test has no business booting a bundler to read
 * twelve rows of numbers out of it.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'client', 'src', 'components', 'pricing', 'PricingManager.jsx');

// What ארגון אמונה sent for תשפ"ז: the full tariff PER PAYMENT, by age group.
const EMUNA_PER_PAYMENT = [4566, 3384, 3001];
// The ministry table for תשפ"ו, whose tariff row this year's is scaled from.
const TARIFF_5786 = [3936, 2917, 2587];
// The convention every subsidised branch is on, and the divisor above.
const INSTALLMENTS = 11;

let failures = 0;
let checks = 0;
function ok(cond, label, detail = '') {
  checks++;
  if (cond) console.log(`  ✅ ${label}`);
  else { failures++; console.log(`  ❌ ${label}${detail ? `  (${detail})` : ''}`); }
  return !!cond;
}

/**
 * The array literal a `const NAME = [...]` declares, as real data.
 *
 * Matched to the first line that is exactly `];` so a `]` inside a label can
 * never end the match early, and evaluated rather than regex-parsed because the
 * rows carry Hebrew labels and decimals and a parser for that is more likely to
 * be wrong than the thing it is checking.
 */
function readTable(source, name) {
  const start = source.indexOf(`const ${name} = [`);
  if (start < 0) throw new Error(`לא נמצא ${name} ב-PricingManager.jsx`);
  const open = source.indexOf('[', start);
  const end = source.indexOf('\n];', open);
  if (end < 0) throw new Error(`לא נמצא סוף הטבלה ${name}`);
  // eslint-disable-next-line no-new-func
  return new Function(`return ${source.slice(open, end + 2)}`)();
}

/** The row a דרגה names, by the first run of digits — the same rule tier-fee.service.js uses. */
function rowFor(table, tier) {
  return table.find(r => String(r.label).match(/\d+/)?.[0] === String(tier));
}

function main() {
  const src = fs.readFileSync(SRC, 'utf8');
  const t5787 = readTable(src, 'TMT_5787');
  const t5786 = readTable(src, 'TMT_5786');

  console.log('\nתשפ"ו — the table this year is derived from');
  const old11 = rowFor(t5786, 11);
  ok(!!old11, 'דרגה 11 קיימת בטבלת תשפ"ו');
  TARIFF_5786.forEach((expected, i) => {
    ok(Number(old11?.prices?.[i]) === expected,
      `תעריף תשפ"ו בעמודה ${i + 1} = ${expected}`,
      `נמצא ${old11?.prices?.[i]}`);
  });

  console.log('\nתשפ"ז — the stored tariff, put back through the screen\'s own 12/11');
  const new11 = rowFor(t5787, 11);
  const new12 = rowFor(t5787, 12);
  ok(!!new11 && !!new12, 'דרגות 11 ו-12 קיימות בטבלת תשפ"ז');
  EMUNA_PER_PAYMENT.forEach((expected, i) => {
    const stored = Number(new11?.prices?.[i]);
    const charged = (stored * 12) / INSTALLMENTS;
    // Half a shekel of slack: 2,750.92 is a rounded monthly figure and comes
    // back as 3,001.004. A whole shekel of drift is a different basis, not
    // rounding, and that is what this is here to catch.
    ok(Math.abs(charged - expected) < 0.5,
      `דרגה 11, עמודה ${i + 1}: ${stored} × 12/${INSTALLMENTS} = ${expected} לתשלום`,
      `יצא ${charged.toFixed(2)} — הטבלה כנראה מחזיקה את הסכום לתשלום במקום את החודשי`);
  });
  ok(JSON.stringify(new11?.prices) === JSON.stringify(new12?.prices),
    'דרגה 12 זהה לדרגה 11 (שתיהן ללא סבסוד — הן התעריף עצמו)');

  console.log('\nתשפ"ז — every subsidised row is תשפ"ו scaled by the same raise');
  // The raise the tariff actually carries, per column, on this table's basis.
  const factor = EMUNA_PER_PAYMENT.map((v, i) => (v * INSTALLMENTS) / 12 / TARIFF_5786[i]);
  factor.forEach((f, i) => {
    ok(f > 1.05 && f < 1.08,
      `שיעור ההעלאה בעמודה ${i + 1} סביר (${((f - 1) * 100).toFixed(2)}%)`,
      `יצא ${((f - 1) * 100).toFixed(2)}% — בדוק את הבסיס`);
  });

  for (const row of t5787) {
    const tier = String(row.label).match(/\d+/)?.[0];
    if (tier === '11' || tier === '12') continue;  // the tariff itself, checked above
    const old = rowFor(t5786, tier);
    if (!ok(!!old, `דרגה ${tier} קיימת גם בתשפ"ו`)) continue;
    row.prices.forEach((price, i) => {
      const expected = Math.round(Number(old.prices[i]) * factor[i]);
      ok(Number(price) === expected,
        `דרגה ${tier}, עמודה ${i + 1}: ${old.prices[i]} → ${expected}`,
        `נמצא ${price}`);
    });
  }

  console.log('\nThe divisor the whole derivation rests on');
  // installments is a per-branch field, but 11 is the ministry-branch
  // convention and the number the tariff above was rebased against. A new
  // pricing document that defaults to anything else charges a different figure
  // from the one the gan committed to.
  ok(/installments:\s*11\b/.test(src),
    'מחירון חדש נפתח עם 11 תשלומים',
    'ברירת המחדל השתנתה — התעריף לעיל נגזר מ-11');

  console.log(`\n${failures ? '❌' : '✅'} ${checks - failures}/${checks} בדיקות עברו`);
  process.exit(failures ? 1 : 0);
}

main();
