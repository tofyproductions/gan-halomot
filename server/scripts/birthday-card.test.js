#!/usr/bin/env node
/**
 * כרטיס יום הולדת — the card still fits on the paper.
 *
 * Everything this guards is invisible in code review and obvious on a
 * printed page. The blessing's lines are broken by hand and the CSS forbids
 * re-wrapping, so a line somebody lengthens by three words does not wrap —
 * it runs off the edge and is simply gone. The name is set in the largest
 * type on the card and shrinks by a table of lengths, so a long name is one
 * step away from the same thing. And a girl handed a card addressed to a boy
 * is the failure nobody would call a bug and everybody would notice.
 *
 * So the checks are: the wording follows the child's gender, nothing is wider
 * than the card at any name length, and the file that comes out is a JPEG of
 * exactly A4 at 300dpi — the size the print shop expects.
 *
 * The render half needs a browser. Render's own Chromium is a Linux binary
 * (@sparticuz/chromium) that will not run on a mac, so this drives the local
 * Chrome that docs/handouts-build.js already relies on, and SKIPS the render
 * checks when there is none rather than failing on a machine that never had
 * one. The markup checks always run.
 *
 *   node scripts/birthday-card.test.js
 */
const fs = require('fs');
const path = require('path');

const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};

const { buildBirthdayCardHtml, CARD_W } = require('../src/services/posterTemplates');

let failures = 0;
let checks = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (cond) console.log(`  ✅ ${label}`);
  else { failures++; console.log(`  ❌ ${label}${detail ? `  (${detail})` : ''}`); }
};
const head = (t) => console.log(`\n${t}`);

/** The text a human reads, with the markup and the stylesheet taken out. */
const visible = (html) => html
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ');

function findChrome() {
  const base = `${process.env.HOME}/.cache/puppeteer/chrome`;
  if (!fs.existsSync(base)) return null;
  for (const v of fs.readdirSync(base).sort().reverse()) {
    const p = path.join(base, v, 'chrome-mac-arm64',
      'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const CARD_H = 1754;          // A4 portrait at 150dpi, the template's own size
const SCALE = 2;              // htmlToPng renders at deviceScaleFactor 2

async function main() {
  console.log('=== כרטיס יום הולדת ===');

  /* ---------------------------------------------------------------- */
  head('1. הנוסח לפי מגדר');
  const boy = visible(buildBirthdayCardHtml({ name: 'נועם', gender: 'boy' }));
  const girl = visible(buildBirthdayCardHtml({ name: 'שירה', gender: 'girl' }));
  const unknown = visible(buildBirthdayCardHtml({ name: 'אורי' }));

  ok(boy.includes('נועם היקר שלנו'), 'לילד — "היקר שלנו"');
  ok(boy.includes('שתצעד תמיד') && boy.includes('שתבקש יתממש'), 'ולשון זכר בברכה');
  ok(girl.includes('שירה היקרה שלנו'), 'לילדה — "היקרה שלנו"');
  ok(girl.includes('שתצעדי תמיד') && girl.includes('שתבקשי יתממש'), 'ולשון נקבה בברכה');
  // Most children have no gender recorded — it is filled in one tap at a time
  // from the שבת rotation — so the masculine wording has to be the default.
  ok(unknown.includes('אורי היקר שלנו'), 'בלי מגדר ידוע — לשון זכר, כמו הנוסח המקורי');

  /* ---------------------------------------------------------------- */
  head('2. כרטיס ריק');
  const blankHtml = buildBirthdayCardHtml({});
  const blank = visible(blankHtml);
  ok(/<span class="blank"><\/span>/.test(blankHtml), 'יש קו לכתיבת השם');
  ok(blank.includes('היקר שלנו'), 'ולידו "היקר שלנו" — באותה שורה');
  ok(blank.includes('היום יש לך יום הולדת'), 'והברכה עצמה שם');

  /* ---------------------------------------------------------------- */
  head('3. הטקסט כפי שנמסר');
  for (const line of [
    'היום יש לך יום הולדת וזה יום כה מיוחד.',
    'רצינו לאחל לך הרבה מהכל ובעיקר',
    'שמחה ואושר, בריאות והרבה חברים.',
  ]) {
    ok(boy.includes(line), `"${line.slice(0, 28)}…"`);
  }
  ok(boy.includes('מזל טוב!'), 'וכותרת "מזל טוב!"');
  ok(boy.includes('באהבה, צוות גן החלומות'), 'וחתימת הגן');

  /* ---------------------------------------------------------------- */
  head('4. שם מהמשתמש אינו קוד');
  const evil = buildBirthdayCardHtml({ name: '<script>alert(1)</script>' });
  ok(!/<script>alert/.test(evil), 'תגית בשם מנוטרלת');
  ok(evil.includes('&lt;script&gt;'), 'ומודפסת כטקסט');

  /* ---------------------------------------------------------------- */
  head('5. הלוגו מוטמע בקובץ');
  // htmlToPng renders with the network cut: a logo referenced by URL would
  // come out as a blank square and nobody would see it until it was printed.
  ok(/<img src="data:image\/png;base64,/.test(blankHtml), 'הלוגו הוא data: URI ולא כתובת');
  // The SVG decorations carry the xmlns, which is a URL and is not fetched.
  const external = blankHtml.replace(/xmlns="[^"]*"/g, '');
  ok(!/https?:\/\//.test(external), 'ואין בקובץ שום כתובת חיצונית');

  /* ---------------------------------------------------------------- */
  head('6. בלי אימוג\'י — הם יצאו ריבועים ריקים באוויר');
  // THE BUG THIS EXISTS FOR: the card was decorated with 🎈🎂🎁⭐ and they
  // rendered perfectly on every machine it was written on. Render's Chromium
  // is a Linux build with no colour-emoji font, so on the live server they
  // came out as four empty squares — on a card a parent was holding. Nothing
  // in the markup looked wrong, and nothing local reproduced it. So: no
  // pictographs anywhere in the document, drawn SVG instead.
  const pictographs = [...buildBirthdayCardHtml({ name: 'נועם', gender: 'boy' })]
    .filter(ch => /\p{Extended_Pictographic}/u.test(ch));
  ok(pictographs.length === 0, 'אין שום תו אימוג\'י בכרטיס',
    pictographs.length ? `נמצאו: ${[...new Set(pictographs)].join(' ')}` : '');
  ok(/<svg /.test(blankHtml), 'והקישוטים מצוירים כ-SVG');

  /* ---------------------------------------------------------------- */
  head('7. רינדור — גודל A4 ושום דבר לא גולש');
  const chrome = findChrome();
  if (!chrome) {
    console.log('  ⏭️  אין דפדפן מקומי — בדיקות הרינדור דולגו');
  } else {
    const puppeteer = require('puppeteer-core');
    const browser = await puppeteer.launch({ executablePath: chrome, headless: true });
    try {
      const cases = [
        ['שם פרטי קצר', { name: 'נועם', gender: 'boy' }],
        ['שם מלא', { name: 'שירה לוי', gender: 'girl' }],
        ['שם ארוך מאוד', { name: 'אביגיל מרגלית בן-שמעון', gender: 'girl' }],
        ['כרטיס ריק', {}],
      ];
      for (const [label, opts] of cases) {
        const page = await browser.newPage();
        try {
          await page.setViewport({ width: CARD_W, height: 1200, deviceScaleFactor: SCALE });
          await page.setContent(buildBirthdayCardHtml(opts), { waitUntil: 'load' });

          const over = await page.evaluate(() => {
            const w = document.querySelector('.card').clientWidth;
            const out = [];
            for (const el of document.querySelectorAll('.name,.body,.foot,.kicker')) {
              const r = el.getBoundingClientRect();
              if (el.scrollWidth > Math.ceil(r.width) + 1 || r.left < 0 || r.right > w) {
                out.push(`${el.className} (${Math.round(r.width)}px מתוך ${w}px)`);
              }
            }
            return { out, h: document.body.scrollHeight };
          });

          ok(!over.out.length, `${label} — שום טקסט לא גולש מהדף`, over.out.join(', '));
          ok(over.h === CARD_H, `${label} — הכרטיס הוא עמוד אחד בדיוק`, `${over.h}px במקום ${CARD_H}px`);

          const buf = Buffer.from(await page.screenshot({ type: 'jpeg', quality: 92, fullPage: true }));
          // ffd8ff is a JPEG's own first three bytes. A PNG here would be a
          // file the print shop sends back.
          ok(buf.slice(0, 3).toString('hex') === 'ffd8ff', `${label} — הקובץ הוא JPEG`);
        } finally { await page.close(); }
      }
    } finally { await browser.close(); }
  }

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} עברו\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('\n❌ נפילה:', err); process.exit(1); });
