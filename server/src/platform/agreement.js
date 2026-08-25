/**
 * The agreement a customer signs, filled in from their own record.
 *
 * WHY IT IS GENERATED RATHER THAN A FILE SOMEBODY EDITS. The commercial terms
 * — the price per child, the bands, the monthly minimum, when the free period
 * ends — are already stored, and they are what the system will actually charge
 * on. A contract typed separately in a word processor is a second copy of
 * those numbers, and the day the two disagree the signed one wins and the
 * system is wrong. Here the paper and the billing read the same row.
 *
 * IT PRINTS. No PDF library, no Chromium launched on a 512MB instance to make
 * a document somebody is going to print anyway: the page is styled for A4 and
 * the browser's own "save as PDF" produces the file. One less dependency in
 * the path of a thing that must work on the day a customer says yes.
 *
 * WHAT IT IS NOT: reviewed by a lawyer. It says so at the top, in a box that
 * does not print — visible to us, absent from the copy a customer sees, so a
 * draft cannot be handed over by accident while still looking like a draft.
 */

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const heDate = (d) => (d ? new Date(d).toLocaleDateString('he-IL') : '');

const money = (n, currency = 'ILS') =>
  (currency === 'ILS' ? '₪' : '') + Number(n || 0).toLocaleString('he-IL');

/** A field only the business can fill. Marked so it cannot be signed as-is. */
const fill = (value, placeholder) => (value
  ? `<b>${esc(value)}</b>`
  : `<span class="fill">${esc(placeholder)}</span>`);

/**
 * How the price reads on paper.
 *
 * A banded price described as "₪50 per child" is how a network decides it was
 * quoted one thing and charged another, so each shape is written in its own
 * words rather than squeezed into one sentence.
 */
function priceClause(pricing) {
  const c = pricing.currency || 'ILS';
  if (pricing.tiers && pricing.tiers.length) {
    const rows = pricing.tiers.map((t) => `
      <tr>
        <td>${t.up_to == null ? 'מעל המדרגה האחרונה' : `עד ${t.up_to} ילדים`}</td>
        <td><b>${money(t.price, c)}</b> לכל ילד</td>
      </tr>`).join('');
    return `
      <p>התמורה נקבעת לפי מספר הילדים הפעילים, במדרגות:</p>
      <table class="terms"><tbody>${rows}</tbody></table>
      <p class="note">
        המדרגה חלה על <b>כל</b> הילדים ולא רק על אלה שמעל הסף. רשת עם 800 ילדים,
        במדרגות של 500 ומעלה, משלמת את מחיר המדרגה העליונה על כל 800.
      </p>`;
  }
  return `<p>התמורה היא <b>${money(pricing.price_per_child, c)}</b> לכל ילד פעיל, לחודש.</p>`;
}

function buildAgreement(tenant, us = {}) {
  const p = tenant.pricing || {};
  const c = p.currency || 'ILS';
  const domain = process.env.PLATFORM_DOMAIN || 'dreamgan.com';
  const address = `${tenant.slug}.${domain}`;
  const freeUntil = p.free_until && new Date(p.free_until) > new Date(0) ? p.free_until : null;

  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<title>הסכם התקשרות — ${esc(tenant.name)}</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0; font-family: Assistant, "Times New Roman", serif; color: #111;
    font-size: 11.5pt; line-height: 1.65;
  }
  .sheet { max-width: 178mm; margin: 0 auto; padding: 10mm 6mm 30mm; }
  h1 { font-size: 19pt; margin: 0 0 2mm; }
  h2 { font-size: 12.5pt; margin: 7mm 0 2mm; }
  .sub { color: #555; font-size: 10.5pt; margin-bottom: 6mm; }
  p, li { margin: 0 0 2.5mm; }
  ol { padding-inline-start: 6mm; }
  ol > li { margin-bottom: 2mm; }
  .note { color: #444; font-size: 10pt; }
  .fill {
    background: #FFF3B0; border-bottom: 1px solid #C9A400;
    padding: 0 4px; font-weight: 700;
  }
  table.terms { width: 100%; border-collapse: collapse; margin: 3mm 0; }
  table.terms td { border: 1px solid #ccc; padding: 2mm 3mm; }
  table.terms td:first-child { width: 45%; color: #444; }
  .parties { display: flex; gap: 6mm; margin: 4mm 0 6mm; }
  .party { flex: 1; border: 1px solid #ddd; border-radius: 3mm; padding: 4mm; }
  .party h3 { margin: 0 0 2mm; font-size: 11pt; }
  .sign { margin-top: 10mm; display: flex; gap: 10mm; }
  .sign div { flex: 1; }
  .line { border-bottom: 1px solid #333; height: 12mm; margin-bottom: 2mm; }
  .draft {
    background: #FBF1E9; border: 1px solid #E0BFA0; border-radius: 3mm;
    padding: 4mm 5mm; margin-bottom: 6mm; font-size: 10pt; color: #7A4520;
  }
  .appendix { page-break-before: always; }
  /* The warning is for us. The copy that reaches a customer must not carry a
     note calling itself a draft — and must not be printed without our having
     seen the warning either. */
  @media print { .draft, .noprint { display: none !important; } }
  .toolbar {
    position: sticky; top: 0; background: #fff; border-bottom: 1px solid #ddd;
    padding: 3mm 5mm; display: flex; gap: 3mm; align-items: center; font-size: 10pt;
  }
  .toolbar button {
    font: inherit; font-weight: 700; padding: 2mm 5mm; border: 0; border-radius: 2mm;
    background: #2E7BC4; color: #fff; cursor: pointer;
  }
</style>
</head>
<body>

<div class="toolbar noprint">
  <button onclick="window.print()">הדפסה / שמירה כ-PDF</button>
  <span>שמירה כ-PDF: בחלון ההדפסה, ביעד — "שמירה כ-PDF".</span>
</div>

<div class="sheet">

<div class="draft">
  <b>טיוטה — לא עברה בדיקה משפטית.</b> נכתבה לפי מה שהמערכת עושה בפועל.
  להעביר לעורך/ת דין לפני שמישהו חותם. השדות הצהובים חייבים להתמלא —
  הם נשארים צהובים גם בהדפסה, כדי שלא ייחתם הסכם עם שדה ריק.
  ההערה הזו עצמה לא מודפסת.
</div>

<h1>הסכם התקשרות</h1>
<div class="sub">מערכת "חלום" לניהול גני ילדים · נערך ונחתם ביום ${fill('', 'תאריך')}</div>

<div class="parties">
  <div class="party">
    <h3>הספק</h3>
    ${fill(us.legal_name, 'שם העוסק / החברה')}<br>
    ח.פ. / ע.מ. ${fill(us.tax_id, 'מספר')}<br>
    ${fill(us.address, 'כתובת')}<br>
    ${esc(us.email || 'halom.dreamgan@gmail.com')}
    ${us.phone ? `<br>${esc(us.phone)}` : ''}
    <div class="note">(להלן: "הספק")</div>
  </div>
  <div class="party">
    <h3>הלקוח</h3>
    ${fill(tenant.billing?.legal_name || tenant.name, 'שם משפטי מלא')}<br>
    ח.פ. / ע.ר. / ע.מ. ${fill(tenant.billing?.tax_id, 'מספר')}<br>
    ${fill(tenant.billing?.address, 'כתובת')}<br>
    ${esc(tenant.contact?.email || '')}
    ${tenant.contact?.phone ? `<br>${esc(tenant.contact.phone)}` : ''}
    <div class="note">(להלן: "הלקוח")</div>
  </div>
</div>

<h2>1. השירות</h2>
<p>
  הספק מעמיד לרשות הלקוח את מערכת "חלום" לניהול גני ילדים, בכתובת
  <b>${esc(address)}</b>, הכוללת: רישום ילדים ושיבוצם, נוכחות, גבייה מהורים,
  ניהול עובדים ושכר, פורטל הורים ודוחות. השימוש הוא בדרך של שירות מרוחק
  (SaaS); הלקוח אינו מקבל עותק של התוכנה.
</p>

<h2>2. תקופת ההתקשרות</h2>
<ol>
  <li>ההתקשרות מתחילה ביום החתימה ונמשכת עד שאחד הצדדים סיים אותה לפי סעיף 8.</li>
  ${freeUntil ? `<li>
    <b>תקופת התנסות ללא תשלום עד ${heDate(freeUntil)}.</b> בתקופה זו השירות מלא,
    ולא ייגבה תשלום. אין התחייבות להמשיך אחריה.
  </li>` : '<li>החיוב מתחיל עם תחילת ההתקשרות. לא סוכמה תקופת התנסות.</li>'}
</ol>

<h2>3. התמורה</h2>
${priceClause(p)}
${p.minimum_monthly > 0 ? `<p>
  <b>מינימום חודשי: ${money(p.minimum_monthly, c)}.</b> אם החישוב לפי מספר הילדים
  נמוך ממנו — ייגבה המינימום.
</p>` : ''}
<p class="note">כל הסכומים אינם כוללים מע"מ, אשר יתווסף כדין.</p>

<h2>4. אופן החיוב</h2>
<ol>
  <li>
    <b>מספר הילדים נספר על ידי המערכת ביום החיוב</b> — לא ממוצע ולא מקסימום.
    ילד שנרשם או עזב אחרי אותו יום משתקף בחיוב של החודש הבא. הלקוח יכול לראות
    בכל רגע, במסך "המנוי שלי", כמה ילדים נספרו ומה החיוב הקרוב.
  </li>
  <li>החיוב חודשי, בהוראת קבע (כרטיס אשראי או חיוב בנקאי), והחשבונית נשלחת ללקוח.</li>
  <li>
    <b>חודש שחויב אינו משתנה למפרע.</b> מספר הילדים, התעריף והסכום נשמרים כפי
    שהיו ביום החישוב, יחד עם הסבר מילולי כיצד התקבל הסכום.
  </li>
  <li>
    שינוי מחיר יחול קדימה בלבד, בהודעה של 30 יום מראש. לקוח שאינו מסכים רשאי
    לסיים לפני כניסת השינוי לתוקף.
  </li>
</ol>

<h2>5. אי-תשלום</h2>
<p>
  לא שולם חשבון, יפנה הספק ללקוח. לא הוסדר — רשאי הספק להשהות את הגישה.
  <b>גם אז המידע נשמר במלואו ואינו נמחק</b>, הגישה מתחדשת מיד עם הסדרת התשלום,
  ובכל עת ניתן לקבל ייצוא מלא של המידע.
</p>

<h2>6. המידע של הלקוח</h2>
<ol>
  <li>
    <b>כל המידע שהוזן למערכת שייך ללקוח.</b> הספק מחזיק בו עבור הלקוח בלבד,
    אינו עושה בו שימוש למטרותיו, אינו מוסרו לאחר, ואינו מאמן עליו מודלים.
  </li>
  <li>ללקוח מסד נתונים נפרד. לקוח אחד אינו יכול לגשת למידע של אחר.</li>
  <li>הלקוח אחראי לחוקיות המידע שהוא מזין ולקבלת ההסכמות הנדרשות מהורים ומעובדים.</li>
  <li>תנאי עיבוד המידע מפורטים בנספח ב', המהווה חלק בלתי נפרד מהסכם זה.</li>
</ol>

<h2>7. זמינות, גיבוי ותמיכה</h2>
<ol>
  <li>
    הספק יפעל במאמץ סביר לזמינות רציפה, ואינו מתחייב לזמינות מלאה. תחזוקה
    מתוכננת שצפויה לפגוע בשימוש — בהודעה מראש.
  </li>
  <li>המערכת מגובה אצל ספק תשתית מסדי הנתונים.</li>
  <li>
    תמיכה בשעות פעילות סבירות. כניסה של הספק למערכת הלקוח נעשית ב<b>הרשאת
    צפייה בלבד</b>, פגה אחרי 30 דקות, ונרשמת ביומן הזמין ללקוח. שינוי בנתונים
    נעשה על ידי הלקוח.
  </li>
</ol>

<h2>8. סיום ההתקשרות</h2>
<ol>
  <li>כל צד רשאי לסיים בהודעה של 30 יום מראש. לא תיגבה תמורה בעד תקופה שלאחריה.</li>
  <li>
    עם הסיום יישמר המידע <b>שישה חודשים</b>. בתקופה זו זכאי הלקוח לייצוא מלא
    בפורמט קריא, ללא תשלום, ורשאי לחדש את ההתקשרות.
  </li>
  <li>
    מחיקת המידע לאחר מכן תיעשה בהחלטת אדם ולאחר ייצוא — ולא באופן אוטומטי.
  </li>
</ol>

<h2>9. אחריות</h2>
<p>
  המערכת היא כלי עזר. <b>האחריות על החלטות ניהוליות, על חישובי שכר ועל דיווחים
  לרשויות היא של הלקוח</b>, אשר יבדוק את הנתונים בטרם יפעל לפיהם. הספק לא יישא
  באחריות לנזק עקיף או תוצאתי, ואחריותו הכוללת לא תעלה על הסכום ששילם הלקוח
  בשנים-עשר החודשים שקדמו לאירוע. אין באמור כדי לגרוע מאחריות שלא ניתן להגבילה
  לפי דין.
</p>

<h2>10. קניין רוחני וסודיות</h2>
<p>
  המערכת, הקוד, העיצוב והשם "חלום" הם של הספק; הלקוח מקבל זכות שימוש בלבד
  לתקופת ההתקשרות. כל צד ישמור בסודיות מידע עסקי של הצד האחר שהגיע אליו
  עקב הסכם זה.
</p>

<h2>11. שונות</h2>
<p>
  על הסכם זה חל הדין הישראלי, וסמכות השיפוט הבלעדית נתונה לבתי המשפט
  ב${fill(us.jurisdiction, 'עיר')}. הודעות יישלחו לכתובות הדואר האלקטרוני
  שבראש ההסכם. הסכם זה ממצה את המוסכם בין הצדדים, וכל שינוי בו — בכתב.
</p>

<div class="sign">
  <div>
    <div class="line"></div>
    <b>הספק</b><br>
    <span class="note">חתימה · שם החותם · תאריך</span>
  </div>
  <div>
    <div class="line"></div>
    <b>הלקוח</b><br>
    <span class="note">חתימה וחותמת · שם החותם ותפקידו · תאריך</span>
  </div>
</div>

<div class="appendix">
  <h1>נספח א' — פירוט התמורה</h1>
  <table class="terms"><tbody>
    <tr><td>כתובת המערכת</td><td><b>${esc(address)}</b></td></tr>
    <tr><td>מודל חיוב</td><td>לפי מספר ילדים פעילים, חודשי</td></tr>
    ${(p.tiers && p.tiers.length)
      ? p.tiers.map((t) => `<tr><td>${t.up_to == null ? 'מעל המדרגה האחרונה' : `עד ${t.up_to} ילדים`}</td><td><b>${money(t.price, c)}</b> לילד</td></tr>`).join('')
      : `<tr><td>מחיר לילד</td><td><b>${money(p.price_per_child, c)}</b></td></tr>`}
    ${p.minimum_monthly > 0 ? `<tr><td>מינימום חודשי</td><td><b>${money(p.minimum_monthly, c)}</b></td></tr>` : ''}
    ${freeUntil ? `<tr><td>תקופת התנסות</td><td>ללא תשלום עד <b>${heDate(freeUntil)}</b></td></tr>` : ''}
    <tr><td>מועד הספירה</td><td>יום החיוב בכל חודש</td></tr>
    <tr><td>אמצעי גבייה</td><td>${fill('', 'כרטיס אשראי / הוראת קבע בנקאית')}</td></tr>
    <tr><td>מע"מ</td><td>יתווסף כדין</td></tr>
  </tbody></table>
  <p class="note">
    הסכומים בנספח זה נלקחו מרישום הלקוח במערכת, והם אותם סכומים שלפיהם היא
    תחייב בפועל.
  </p>
</div>

<div class="appendix">
  <h1>נספח ב' — עיבוד מידע אישי</h1>
  <p>
    לצורך תקנות הגנת הפרטיות (אבטחת מידע), <b>הלקוח הוא בעל מאגר המידע והספק
    הוא מחזיק בו</b>. הספק מעבד מידע אישי אך ורק לפי הוראות הלקוח ולצורך מתן
    השירות.
  </p>

  <h2>1. סוגי המידע והנושאים</h2>
  <p>
    ילדים (שם, תאריך לידה, מספר זהות, שיבוץ, נוכחות, תשלומים, ובגנים שבחרו בכך
    — אישורי מחלה והערות בריאות); הורים (שם, טלפון, אימייל, מספר זהות, פרטי
    חיוב); עובדים (שם, מספר זהות, שעות, שכר וניכויים, מסמכי העסקה, פרטי בנק).
  </p>

  <h2>2. אבטחה</h2>
  <ul>
    <li>הצפנת התעבורה מקצה לקצה (HTTPS), לרבות מול מסד הנתונים</li>
    <li>סיסמאות נשמרות כטביעה חד-כיוונית בלבד ואינן ניתנות לקריאה</li>
    <li>הפרדה מלאה בין לקוחות ברמת מסד הנתונים</li>
    <li>הרשאות לפי תפקיד — מידע שאין הרשאה אליו אינו נשלח מהשרת</li>
    <li>יומן פעולות על הפעולות הרגישות, זמין ללקוח</li>
  </ul>

  <h2>3. גישת הספק</h2>
  <p>
    הספק אינו נכנס למערכת הלקוח בשגרה. כניסת תמיכה היא בהרשאת <b>צפייה בלבד</b>,
    פוקעת אחרי 30 דקות, ונרשמת ביומן עם זהות הנכנס והסיבה.
  </p>

  <h2>4. ספקי משנה</h2>
  <p>
    הספק נעזר בשירותי תשתית: אחסון ומסדי נתונים, שליחת דואר אלקטרוני והודעות
    SMS, ובגנים שבחרו להפעיל זאת — שירות בינה מלאכותית לקריאה אוטומטית של
    אישורי מחלה וטופסי 101, שאליו נשלח <b>תוכן המסמך שצולם</b>. הרשימה המלאה
    והמעודכנת מפורסמת ב-${esc(domain)}/privacy. <b>ניתן לכבות את הסריקה
    האוטומטית</b>, ואז לא נשלח מסמך לשום גורם.
  </p>

  <h2>5. מיקום המידע</h2>
  <p>
    השרתים ומסדי הנתונים פועלים מחוץ לישראל, באיחוד האירופי. הלקוח מאשר את
    העברת המידע ואחסונו כאמור.
  </p>

  <h2>6. אירוע אבטחה</h2>
  <p>
    אירע אצל הספק אירוע אבטחה הנוגע למידע הלקוח — יודיע לו ללא דיחוי, ימסור את
    הידוע לו, וישתף פעולה בטיפול ובדיווח הנדרש לפי דין.
  </p>

  <h2>7. סיום</h2>
  <p>
    בתום ההתקשרות יעמיד הספק לרשות הלקוח ייצוא מלא של המידע. המידע יישמר שישה
    חודשים, ולאחר מכן יימחק בהחלטה של אדם ולאחר ייצוא.
  </p>

  <h2>8. פניות של נושאי מידע</h2>
  <p>
    פנייה של הורה, ילד או עובד לעיון במידע, לתיקונו או למחיקתו — מופנית ללקוח,
    שהוא בעל המאגר. הספק יסייע ללקוח לענות.
  </p>

  <div class="sign">
    <div><div class="line"></div><b>הספק</b></div>
    <div><div class="line"></div><b>הלקוח</b></div>
  </div>
</div>

</div>
</body>
</html>`;
}

module.exports = { buildAgreement };
