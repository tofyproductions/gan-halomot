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
const LOGO = fs.readFileSync(path.join(__dirname, 'logo.b64'), 'utf8');

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
    width: 210mm; height: 297mm; overflow: hidden;
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
    padding: 5mm 6mm;
    font-size: 11pt; line-height: 1.7;
    margin-bottom: 7mm;
  }
  .lead strong { color: var(--brand); }

  h2 {
    font-size: 13.5pt; font-weight: 700;
    margin: 0 0 4mm; padding-bottom: 2mm;
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

  .link-card {
    text-align: center;
    background: var(--brand); color: #fff;
    border-radius: 4mm; padding: 4mm 5mm; margin: 2mm 0 6mm;
  }
  .link-card .label { font-size: 10pt; opacity: 0.9; margin-bottom: 1.5mm; }
  .link-card .url {
    direction: ltr; unicode-bidi: isolate;
    font-family: "SF Mono", Menlo, monospace;
    font-size: 11.5pt; font-weight: 700; word-break: break-all;
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

  table { border-collapse: collapse; width: 100%; font-size: 10.3pt; margin-bottom: 5mm; }
  th, td { border: 1pt solid var(--line); padding: 2.6mm 3.5mm; text-align: right; vertical-align: top; }
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
const PLAY = 'bit.ly — או חיפוש "גן החלומות" בחנות';

const parents = page(`
${head('התחדשנו באפליקציה', 'כל מה שקורה לילד/ה שלכם בגן — במקום אחד, בטלפון')}

<div class="lead">
  מהיום אפשר לראות את <strong>היום של הילד/ה בגן</strong> — מה אכל/ה, מתי ישן/ה,
  איך עבר היום — וגם תמונות, הודעות מהגן, תשלומים ודיווח על היעדרות.
  הכניסה היא <strong>אישית ומאובטחת</strong>, וכל הורה רואה רק את הילדים שלו.
</div>

<h2>איך נכנסים — 4 צעדים</h2>
<ol class="steps">
  <li>
    <div class="t">מתקינים את האפליקציה</div>
    <div class="d">
      בחנות של גוגל פליי מחפשים <strong>גן החלומות</strong> ומתקינים.<br>
      <strong>באייפון</strong> — האפליקציה עדיין לא בחנות של אפל, ולכן נכנסים דרך
      הדפדפן לכתובת שלמטה ומוסיפים אותה למסך הבית.
    </div>
  </li>
  <li>
    <div class="t">נכנסים למסך ההורים</div>
    <div class="d">
      בפתיחה הראשונה מופיע מסך כניסה של הצוות. גוללים למטה ולוחצים
      <strong>"לכניסת ההורים"</strong>.
    </div>
  </li>
  <li>
    <div class="t">מזינים תעודת זהות ולוחצים "כניסה ראשונה"</div>
    <div class="d">
      <strong>תעודת הזהות של ההורה</strong> — לא של הילד/ה.
      יישלח אליכם קוד בן 6 ספרות ב-SMS, למספר הנייד שרשום אצלנו בגן.
    </div>
  </li>
  <li>
    <div class="t">בוחרים סיסמה — וזהו</div>
    <div class="d">
      מקלידים את הקוד, בוחרים סיסמה אישית, ונכנסים. בפעמים הבאות
      נכנסים עם תעודת זהות וסיסמה בלבד.
    </div>
  </li>
</ol>

<div class="link-card">
  <div class="label">הכניסה מהדפדפן — גם לאייפון</div>
  <div class="url">${PORTAL}</div>
</div>

<div class="note">
  <span class="h">לא קיבלתם קוד?</span>
  סימן שהמספר שרשום אצלנו בגן אינו מעודכן, או שהוקלדה תעודת זהות של הילד/ה
  במקום של ההורה. דברו איתנו במשרד ונסדר את זה בדקה.
</div>

<div class="note">
  <span class="h">חשוב לדעת</span>
  האפליקציה <strong>לא שולחת התראות</strong> על הודעות חדשות. נמשיך לעדכן אתכם
  בקבוצת הוואטסאפ כרגיל — האפליקציה היא המקום לראות בו את הפרטים, לא
  תחליף להודעות.
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
  בדיוק כמו בלוח הישן — מה אכל/ה בבית ומתי קם/ה. זה מופיע לכן בכרטיס הילד/ה.
  הם יכולים למלא <strong>רק על היום עצמו</strong>, לא על ימים שעברו.
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

const doc = (title, body) => `<!doctype html>
<html lang="he" dir="rtl"><meta charset="utf-8"><title>${title}</title>
<style>${CSS}</style><body>${body}</body></html>`;

(async () => {
  const browser = await puppeteer.launch({
    executablePath: findChrome(), headless: true,
    args: ['--no-sandbox', '--font-render-hinting=none'],
  });
  try {
    const jobs = [
      ['הורים — איך נכנסים לאפליקציה.pdf', doc('הורים — התחברות', parents)],
      ['צוות — הלוח היומי במערכת.pdf', doc('צוות — הלוח היומי', staff)],
    ];
    for (const [name, html] of jobs) {
      const p = await browser.newPage();
      await p.setContent(html, { waitUntil: 'load', timeout: 60000 });
      await p.pdf({
        path: path.join(__dirname, name),
        format: 'A4', printBackground: true,
        margin: { top: 0, bottom: 0, left: 0, right: 0 },
      });
      await p.close();
      console.log(`✅ ${name}`);
    }
  } finally { await browser.close(); }
})().catch((e) => { console.error(`❌ ${e.message}`); process.exit(1); });
