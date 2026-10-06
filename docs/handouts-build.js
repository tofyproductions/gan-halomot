#!/usr/bin/env node
/**
 * The two handouts: one for the families, one for the staff room.
 *
 * Built as HTML and printed by the same local Chromium the runbook uses, so
 * nothing about the gan leaves this machine. The gan's own identity — the
 * rainbow and "כל ילד חולם להיות בו" — rather than the product's.
 */
const fs = require('fs');
const path = require('path');

const SERVER = '/Users/amitkohta/Desktop/Claude Code Apps/אפליקציות/gan-halomot/server';
const puppeteer = require(path.join(SERVER, 'node_modules/puppeteer-core'));
const QRCode = require('qrcode');
const LOGO = fs.readFileSync(path.join(__dirname, 'logo.b64'), 'utf8');

/**
 * The address as a square somebody points a camera at.
 *
 * A printed URL is a thing to be retyped, and this one has a hyphen, a dot
 * nobody expects and a path — on a page that is otherwise Hebrew, where the
 * reader has to switch keyboards to type it. The code is high-correction so it
 * still scans off a photocopy pinned to a noticeboard, and black on white
 * because a tinted one is what phone cameras fail on.
 */
const qrSvg = (text) => QRCode.toString(text, {
  type: 'svg', errorCorrectionLevel: 'H', margin: 0,
  color: { dark: '#2B2119', light: '#FFFFFF' },
});

function findChrome() {
  const base = `${process.env.HOME}/.cache/puppeteer/chrome`;
  for (const v of fs.readdirSync(base).sort().reverse()) {
    const p = path.join(base, v, 'chrome-mac-arm64',
      'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
    if (fs.existsSync(p)) return p;
  }
  throw new Error('לא נמצא דפדפן לרינדור');
}

/**
 * The gan's palette, taken from the parent portal's own theme so the paper in
 * a parent's hand and the screen they open look like the same place: warm
 * paper, burnt orange, and the rainbow's own colours for the step markers.
 */
const CSS = `
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }

  :root {
    --ink: #2B2119;
    --soft: #6B5C4E;
    --paper: #FFFFFF;
    --ground: #FAF6F0;
    --brand: #B4540A;
    --brand-soft: #FFF1DC;
    --line: #EADFD0;
  }

  body {
    font-family: "Rubik", "Assistant", "Arial Hebrew", Arial, sans-serif;
    color: var(--ink);
    margin: 0;
    background: var(--paper);
    -webkit-font-smoothing: antialiased;
  }

  /* An exact height, not a minimum. At a minimum of 297mm the flex container
     is already a full sheet, and the footer's own border and padding tip it a
     millimetre over — so a one-page handout printed as two, the second
     holding nothing but the footer. */
  .page {
    width: 210mm; height: 297mm;
    padding: 13mm 15mm 10mm;
    display: flex; flex-direction: column;
    background:
      radial-gradient(120% 55% at 50% 0%, var(--brand-soft) 0%, rgba(255,241,220,0) 62%),
      var(--paper);
  }
  .page + .page { break-before: page; page-break-before: always; }

  header { text-align: center; margin-bottom: 7mm; }
  header img { width: 46mm; height: auto; display: block; margin: 0 auto 3mm; }

  h1 {
    font-size: 23pt; font-weight: 700; margin: 0 0 2mm;
    letter-spacing: -0.3pt; line-height: 1.25;
  }
  .sub { font-size: 11.5pt; color: var(--soft); margin: 0; line-height: 1.5; }

  .lead {
    background: var(--ground);
    border: 1pt solid var(--line);
    border-radius: 5mm;
    padding: 4.2mm 5.5mm;
    font-size: 10.8pt; line-height: 1.65;
    margin-bottom: 5mm;
  }
  .lead strong { color: var(--brand); }

  h2 {
    font-size: 13.5pt; font-weight: 700;
    margin: 0 0 3.2mm; padding-bottom: 1.6mm;
    border-bottom: 1.5pt solid var(--brand);
    display: inline-block;
  }

  ol.steps { list-style: none; counter-reset: s; padding: 0; margin: 0 0 6mm; }
  ol.steps > li {
    counter-increment: s;
    position: relative;
    padding-inline-start: 13mm;
    margin-bottom: 4.6mm;
    min-height: 9mm;
  }
  ol.steps > li::before {
    content: counter(s);
    position: absolute; inset-inline-start: 0; top: -0.5mm;
    width: 9mm; height: 9mm; border-radius: 50%;
    background: var(--brand); color: #fff;
    font-size: 12pt; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
  }
  ol.steps .t { font-size: 12pt; font-weight: 700; line-height: 1.4; }
  ol.steps .d { font-size: 10.3pt; color: var(--soft); line-height: 1.65; margin-top: 1mm; }
  ol.steps .d strong { color: var(--ink); }

  /* A link or a code is Latin inside Hebrew: isolated, or it reorders on the
     page and somebody types it wrong. */
  .ltr {
    direction: ltr; unicode-bidi: isolate; display: inline-block;
    font-family: "SF Mono", Menlo, monospace;
    background: var(--ground); border: 1pt solid var(--line);
    border-radius: 2mm; padding: 0.4mm 1.6mm; font-size: 9.6pt;
  }

  /* The scan block: the square big enough to read across a corridor, the
     address beside it in small type for anyone without a working camera. */
  .scan {
    display: flex; align-items: center; gap: 6mm;
    background: var(--brand); color: #fff;
    border-radius: 4mm; padding: 5mm 6mm; margin: 0 0 5mm;
  }
  .scan .qr {
    flex: 0 0 auto; width: 32mm; height: 32mm;
    background: #fff; border-radius: 2.5mm; padding: 2mm;
  }
  .scan .qr svg { width: 100%; height: 100%; display: block; }
  .scan .txt { flex: 1 1 auto; }
  .scan .big { font-size: 14pt; font-weight: 700; line-height: 1.35; margin-bottom: 1.5mm; }
  .scan .small { font-size: 9.6pt; opacity: 0.92; line-height: 1.55; }
  .scan .url {
    direction: ltr; unicode-bidi: isolate; display: inline-block;
    font-family: "SF Mono", Menlo, monospace;
    font-size: 9.2pt; margin-top: 1.5mm; opacity: 0.92;
  }

  .note {
    border-inline-start: 3pt solid var(--brand);
    background: var(--brand-soft);
    border-radius: 0 3mm 3mm 0;
    padding: 3.4mm 4.5mm; margin-bottom: 3.8mm;
    font-size: 10.1pt; line-height: 1.6;
  }
  .note .h { font-weight: 700; display: block; margin-bottom: 0.8mm; }

  ul.plain { padding-inline-start: 5mm; margin: 0 0 5mm; font-size: 10.6pt; line-height: 1.8; }
  ul.plain li { margin-bottom: 1.5mm; }

  table { border-collapse: collapse; width: 100%; font-size: 10.2pt; margin-bottom: 4mm; }
  th, td { border: 1pt solid var(--line); padding: 2.2mm 3.2mm; text-align: right; vertical-align: top; }
  th { background: var(--ground); font-weight: 700; }

  footer {
    margin-top: auto; padding-top: 5mm;
    border-top: 1pt solid var(--line);
    font-size: 9.4pt; color: var(--soft);
    display: flex; justify-content: space-between; gap: 5mm;
  }
`;

const page = (inner) => `<div class="page">${inner}</div>`;

const head = (title, sub) => `<header>
  <img src="${LOGO}" alt="גן החלומות">
  <h1>${title}</h1>
  <p class="sub">${sub}</p>
</header>`;

const foot = (right) => `<footer><span>${right}</span><span>גן החלומות · 052-3866819</span></footer>`;

/* ------------------------------------------------------------------ *
 * For the families.
 * ------------------------------------------------------------------ */
const PORTAL = 'gan-halomot.onrender.com/parents';
const STAFF_PORTAL = 'gan-halomot.onrender.com';
const PLAY = 'bit.ly — או חיפוש "גן החלומות" בחנות';

const parents = (qr) => page(`
${head('התחדשנו באפליקציה', 'כל מה שקורה לילד/ה שלכם בגן — במקום אחד, בטלפון')}

<div class="lead">
  מהיום אפשר לראות את <strong>היום של הילד/ה בגן</strong> — מה אכל/ה, מתי ישן/ה,
  איך עבר היום — וגם תמונות, הודעות מהגן, תשלומים ודיווח על היעדרות.
  הכניסה <strong>אישית ומאובטחת</strong>, וכל הורה רואה רק את הילדים שלו.
</div>

<div class="scan">
  <div class="qr">${qr}</div>
  <div class="txt">
    <div class="big">סורקים את הקוד<br>עם מצלמת הטלפון</div>
    <div class="small">
      פותחים מצלמה, מכוונים לריבוע, ולוחצים על הקישור שקופץ.
      <span class="url">${PORTAL}</span>
    </div>
  </div>
</div>

<h2>ואז — 3 צעדים</h2>
<ol class="steps">
  <li>
    <div class="t">מזינים תעודת זהות ולוחצים "כניסה ראשונה"</div>
    <div class="d">
      <strong>תעודת הזהות של ההורה</strong> — לא של הילד/ה.
      יישלח אליכם קוד בן 6 ספרות ב-SMS, למספר הנייד שרשום אצלנו בגן.
    </div>
  </li>
  <li>
    <div class="t">מקלידים את הקוד ובוחרים סיסמה</div>
    <div class="d">בפעמים הבאות נכנסים עם תעודת זהות וסיסמה בלבד.</div>
  </li>
  <li>
    <div class="t">מוסיפים למסך הבית — וזה נראה כמו אפליקציה</div>
    <div class="d">
      <strong>אייפון:</strong> כפתור השיתוף ← "הוספה למסך הבית".
      <strong>אנדרואיד:</strong> שלוש הנקודות ← "הוספה למסך הבית".
    </div>
  </li>
</ol>

<div class="note">
  <span class="h">לא קיבלתם קוד?</span>
  סימן שהמספר שרשום אצלנו אינו מעודכן, או שהוקלדה תעודת זהות של הילד/ה
  במקום של ההורה. דברו איתנו במשרד ונסדר את זה בדקה.
</div>

<div class="note">
  <span class="h">חשוב לדעת</span>
  המערכת <strong>לא שולחת התראות</strong> על עדכונים חדשים. נמשיך לעדכן אתכם
  בקבוצת הוואטסאפ כרגיל — זה המקום לראות בו את הפרטים, לא תחליף להודעות.
</div>

${foot('הוראות התחברות להורים')}
`);

/* ------------------------------------------------------------------ *
 * For the staff room.
 * ------------------------------------------------------------------ */
const staff = page(`
${head('הלוח היומי במערכת', 'מה משתנה בתינוקייה, ומה ההורים רואים')}

<div class="lead">
  מהשבוע הורי התינוקייה מתחילים לראות את <strong>הלוח היומי במערכת</strong>,
  בדיוק כמו שראו עד היום בלוח הישן. מה שאתן ממלאות — ההורים רואים.
  <strong>אותה עבודה, מסך אחר.</strong>
</div>

<h2>מה אתן עושות</h2>
<ol class="steps">
  <li>
    <div class="t">נכנסות לאפליקציה כרגיל</div>
    <div class="d">שם מלא + תעודת זהות, ואז סיסמה. מי שעוד לא הגדירה סיסמה — לפנות למשרד.</div>
  </li>
  <li>
    <div class="t">בוחרות "לוח יומי" בתפריט</div>
    <div class="d">הכיתה נטענת עם כל הילדים של היום.</div>
  </li>
  <li>
    <div class="t">ממלאות במהלך היום</div>
    <div class="d">
      אוכל, שינה, החתלות, מצב רוח — אותם שדות שהכרתן.
      למעלה יש גם <strong>"תפריט היום"</strong>: מסמנות מה הוגש בפועל.
    </div>
  </li>
</ol>

<h2>מה ההורים רואים ומה לא</h2>
<table>
  <tr><th>רואים</th><th>לא רואים</th></tr>
  <tr>
    <td>
      את הילד/ה שלהם בלבד<br>
      את מה שמילאתן על היום<br>
      תפריט, תמונות הכיתה, הודעות
    </td>
    <td>
      ילדים אחרים ושמותיהם<br>
      הערות פנימיות של הצוות<br>
      כל דבר בכיתה אחרת או בסניף אחר
    </td>
  </tr>
</table>

<div class="note">
  <span class="h">ההורים ממלאים את "הבוקר בבית"</span>
  כמו בלוח הישן — מה אכל/ה בבית ומתי קם/ה. זה מופיע לכן בכרטיס הילד/ה,
  ורק על היום עצמו, לא על ימים שעברו.
</div>

<div class="note">
  <span class="h">אם הורה אומר שהוא לא מצליח להיכנס</span>
  לא לנסות לפתור בכיתה — להפנות למשרד. ברוב המקרים זה מספר נייד
  לא מעודכן אצלנו, וזה תיקון של דקה במשרד.
</div>

<div class="note">
  <span class="h">תמונות</span>
  תמונה שאתן מעלות נראית להורי הכיתה במשך שבוע. הורה שמסמן "זה הילד שלי"
  על תמונה — זה מגיע אליכן לאישור ולא משנה כלום עד שתאשרו.
</div>

${foot('הנחיות לצוות התינוקייה')}
`);

/* ------------------------------------------------------------------ *
 * For the staff room wall: every screen, and what it is for.
 *
 * Written for the גננת, who sees six of the thirteen. The rest are marked
 * rather than hidden, because a list that quietly omits them leaves somebody
 * wondering whether she is missing a screen or missing a permission — and
 * the answer to that one is "ask the office", which she can only do if she
 * knows there is something to ask about.
 * ------------------------------------------------------------------ */
const screenRow = (name, who, what) => `
  <tr>
    <td style="font-weight:700;white-space:nowrap">${name}</td>
    <td>${what}</td>
    <td style="white-space:nowrap;color:var(--soft);font-size:9.4pt">${who}</td>
  </tr>`;

const staffScreens = (qr) => page(`
${head('האפליקציה של הגן', 'מה יש בה, ומה אפשר לעשות בכל מסך')}

<div class="scan">
  <div class="qr">${qr}</div>
  <div class="txt">
    <div class="big">נכנסים לראשונה</div>
    <div class="small">
      סורקים, ואז <strong>שם מלא + תעודת זהות</strong>. זהו — אין סיסמה בכניסה
      הראשונה. המערכת תציע לבחור סיסמה, וכדאי לבחור.
      <span class="url">${STAFF_PORTAL}</span>
    </div>
  </div>
</div>

<h2>שני הדברים החשובים</h2>
<ol class="steps">
  <li>
    <div class="t">לוח יומי — ממלאים במהלך היום</div>
    <div class="d">
      אוכל, שינה, החתלות, מצב רוח, ותפריט היום. <strong>ההורים רואים את זה
      באזור האישי שלהם</strong>, אז מה שנרשם כאן הוא מה שההורה יודע בערב.
    </div>
  </li>
  <li>
    <div class="t">תמונות — מעלים מהטלפון</div>
    <div class="d">
      בוחרים כיתה, מצלמים או בוחרים מהגלריה, מעלים. התמונות נראות
      <strong>להורי הכיתה בלבד, במשך שבוע</strong>. הורה יכול לסמן "זה הילד
      שלי" — זה מגיע אליכן לאישור ולא משנה כלום עד שתאשרו.
    </div>
  </li>
</ol>

${foot('מדריך לצוות החינוכי')}
`) + page(`
<h2>כל המסכים</h2>

<table>
  <tr><th style="width:22%">המסך</th><th>מה עושים בו</th><th style="width:16%">מי רואה</th></tr>
  ${screenRow('לוח יומי', 'כולן', 'היום של כל ילד/ה — אוכל, שינה, החתלות, תפריט. ההורים רואים.')}
  ${screenRow('תמונות', 'כולן', 'העלאת תמונות לכיתה. נראות להורי הכיתה במשך שבוע.')}
  ${screenRow('מה חסר', 'כולן', 'מסמנות מה אזל בכיתה — מגבונים, טיטולים. המשרד רואה ומזמין.')}
  ${screenRow('מורשי איסוף', 'כולן', 'מי מותר לו לאסוף כל ילד/ה. לבדוק לפני שמוסרים.')}
  ${screenRow('היעדרויות', 'גננת', 'מי דיווח מראש שלא מגיע.')}
  ${screenRow('הודעות לגן', 'גננת', 'כותבות הודעה להורים. מנהלת הסניף מפרסמת אותה.')}
  ${screenRow('עדכונים מהורים', 'אחראית', 'מה הורים שינו בפרטים — אלרגיה, כתובת, טלפון.')}
  ${screenRow('מעקב חוגים', 'אחראית', 'מי רשום לאיזה חוג ומי הגיע.')}
  ${screenRow('גאנט', 'אחראית', 'תוכנית החודש. מה שמאושר מוצג להורים.')}
  ${screenRow('מתנות', 'אחראית', 'בחירת התמונה שתודפס על המתנה.')}
  ${screenRow('הזמנות', 'אחראית', 'בניית הזמנה לספק. נשלחת לאישור ההנהלה.')}
  ${screenRow('מעקב מלאי', 'אחראית', 'מה יש במחסן ומה נגמר.')}
  ${screenRow('אחזקה', 'אחראית', 'דיווח על תקלה — ברז, תאורה, ריהוט.')}
</table>

<div class="note">
  <span class="h">"כולן" / "גננת" / "אחראית"</span>
  סייעת רואה את מה שמסומן "כולן". גננת רואה גם את מה שמסומן "גננת".
  גננת אחראית רואה את הכול. אם מסך שאמור להיות לכן לא מופיע — זה עניין
  של הרשאה, ופותרים אותו במשרד.
</div>

<div class="note">
  <span class="h">החתמות</span>
  הכניסה והיציאה נרשמות במערכת. אם יום יצא בלי החתמה תקבלו על כך הודעה
  ותוכלו להסביר מה קרה — עדיף לטפל בזה מיד ולא בסוף החודש.
</div>

<div class="note">
  <span class="h">לא בטוחות במשהו?</span>
  אף פעולה במסכים האלה אינה סופית בלי אישור — הזמנה הולכת להנהלה, הודעה
  להורים מתפרסמת על ידי מנהלת הסניף, וסימון של הורה על תמונה מחכה לכן.
  מותר להתנסות.
</div>

${foot('מדריך לצוות החינוכי')}
`);

const doc = (title, body) => `<!doctype html>
<html lang="he" dir="rtl"><meta charset="utf-8"><title>${title}</title>
<style>${CSS}</style><body>${body}</body></html>`;

/**
 * Each handout is one sheet, and the check is on the PDF rather than on the
 * eye: these were clipped once already — an exact page height with hidden
 * overflow silently cut the last paragraph off, and a page that LOOKS finished
 * is exactly the failure that reaches a noticeboard. Overflow now spills to a
 * second page, which is loud, and this counts them.
 */
const pageCount = (file) => {
  const buf = fs.readFileSync(file);
  return (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
};

(async () => {
  const qr = await qrSvg(`https://${PORTAL}`);
  const staffQr = await qrSvg(`https://${STAFF_PORTAL}`);

  const browser = await puppeteer.launch({
    executablePath: findChrome(), headless: true,
    args: ['--no-sandbox', '--font-render-hinting=none'],
  });
  let bad = 0;
  try {
    const jobs = [
      ['הורים — איך נכנסים לאפליקציה.pdf', doc('הורים — התחברות', parents(qr))],
      ['צוות — הלוח היומי במערכת.pdf', doc('צוות — הלוח היומי', staff)],
      ['צוות — מדריך לאפליקציה.pdf', doc('צוות — מדריך לאפליקציה', staffScreens(staffQr))],
    ];
    for (const [name, html] of jobs) {
      const file = path.join(__dirname, name);
      const p = await browser.newPage();
      await p.setContent(html, { waitUntil: 'load', timeout: 60000 });
      await p.pdf({
        path: file, format: 'A4', printBackground: true,
        margin: { top: 0, bottom: 0, left: 0, right: 0 },
      });
      await p.close();

      const pages = pageCount(file);
      const want = name.includes('מדריך') ? 2 : 1;
      if (pages === want) console.log(`✅ ${name} (${pages} עמ')`);
      else { bad++; console.log(`❌ ${name} — ${pages} עמודים, ציפינו ${want}`); }
    }
  } finally { await browser.close(); }
  if (bad) process.exit(1);
})().catch((e) => { console.error(`❌ ${e.message}`); process.exit(1); });
