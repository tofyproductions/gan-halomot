const { calculateFirstMonthPayment, calculateAugustPayment } = require('./prorate.service');
const { getHebrewYear } = require('./academic-year.service');

/**
 * Generate contract HTML string from registration data
 */
function generateContractHTML(data) {
  const today = new Date().toLocaleDateString('he-IL');
  const schoolYear = getHebrewYear(data.start_date || data.startDate);

  const config = (typeof data.configuration === 'string'
    ? JSON.parse(data.configuration || '{}')
    : data.configuration) || {};

  const childName = data.child_name || data.childName || '';
  const parentName = data.parent_name || data.parentName || '';
  const parentId = data.parent_id_number || data.parentId || '';
  const classroom = data.classroom || '';
  const monthlyFee = parseFloat(data.monthly_fee || data.monthlyFee || 0);
  const regFee = parseFloat(data.registration_fee || data.regFee || 0);
  const startDate = data.start_date || data.startDate;
  const endDate = data.end_date || data.endDate;
  const startTime = config.start_time || data.startTime || '07:00';
  const endTime = config.end_time || data.endTime || '17:00';
  const friEnd = config.fri_time || data.friTime || '12:30';
  const signature = data.signature_data || data.signature || '';

  const augCalc = calculateAugustPayment(monthlyFee, startDate);
  const firstMonth = calculateFirstMonthPayment(monthlyFee, startDate);

  const formatDate = (d) => {
    if (!d) return '';
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return d;
    return `${String(dt.getDate()).padStart(2, '0')}.${String(dt.getMonth() + 1).padStart(2, '0')}.${dt.getFullYear()}`;
  };

  const formatNIS = (n) => {
    const num = parseFloat(n) || 0;
    return num.toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₪';
  };

  const friRange = `${startTime}-${friEnd}`;
  const monthlyFeeStr = `${monthlyFee.toLocaleString('he-IL')} ₪`;
  const regFeeStr = `${regFee.toLocaleString('he-IL')} ₪`;
  const firstMonthStr = `${parseFloat(firstMonth.fee || firstMonth).toLocaleString('he-IL')} ₪`;
  const augFormatted = formatNIS(augCalc.total);

  return `
    <!DOCTYPE html>
    <html dir="rtl" lang="he">
    <head>
      <meta charset="UTF-8">
      <style>
        body { font-family: 'Assistant', 'Heebo', 'Arial', sans-serif; max-width: 860px; margin: 0 auto; line-height: 1.7; color: #0f172a; padding: 50px 60px; }
        h1 { text-align: center; color: #1e3a8a; font-size: 1.6rem; margin-bottom: 8px; }
        h4 { color: #1e3a8a; text-decoration: underline; margin-top: 28px; margin-bottom: 8px; font-size: 1.1rem; }
        ol { padding-right: 22px; margin-top: 6px; }
        li { margin-bottom: 6px; text-align: justify; }
        .summary { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 16px 20px; margin: 18px 0 8px; display: flex; gap: 24px; flex-wrap: wrap; justify-content: center; font-size: 0.95rem; }
        .summary div { white-space: nowrap; }
        .sig-box { margin-top: 36px; border: 2px solid #3b82f6; padding: 18px 22px; border-radius: 12px; display: inline-block; }
        .sig-box img { max-width: 280px; max-height: 120px; display: block; margin-top: 6px; }
        .sig-meta { font-size: 0.85rem; color: #64748b; margin-top: 4px; }
        b { font-weight: 700; }
      </style>
    </head>
    <body>
      <h1>הסכם התקשרות ורישום - שנה"ל ${schoolYear}</h1>
      <div class="summary">
        <div><b>ילד/ה:</b> ${childName}</div>
        <div><b>הורה:</b> ${parentName}${parentId ? ` (ת.ז. ${parentId})` : ''}</div>
        <div><b>קבוצה:</b> ${classroom}</div>
        <div><b>תאריך חתימה:</b> ${today}</div>
      </div>

      <h4>ההתקשרות:</h4>
      <ol>
        <li>ההורה מתקשר עם הגננת לקבלת שרותי גן – ילדים לבנו/לביתו (שם הילד/ה): ${childName} לכיתת ${classroom}.</li>
        <li>תקופת הלימודים תחל בתאריך: ${formatDate(startDate)} ותסתיים בתאריך: ${formatDate(endDate)} (להלן: "שנה"ל").</li>
        <li>שעות הימצאות הילד/ה בגן יחלו בשעה: ${startTime} ויסתיימו בשעה: ${endTime} - ימי שישי: ${friRange} (להלן: "שעות הפעילות").</li>
        <li>שכר הלימוד מקנה לילד/ה זכות לימוד בגן בשעות ובימים הקבועים בו פועל הגן והכול ע"פ הנחיות משרד החינוך.</li>
        <li>הגן יהיה סגור בימי חג, שבתון וחופשה הנהוגים והמקובלים ע"י משרד החינוך ו/או מעונות היום ובהתאם ללוח חופשות הגן.</li>
        <li>שכר הלימוד ישולם גם בגין תקופה של היעדרות הילד/ה מהגן הן מסיבת מחלה ו/או מכל סיבה אחרת.</li>
        <li>ההורה ישא בתשלומי ביטוח תאונות אישיות (נכלל בדמי הרישום) עבור הילד/ה בהתאם לפוליסת הביטוח ולהסדר הגן עם חברת הביטוח.</li>
        <li>ההורה מתחייב להביא את הילד/ה לגן בבוקר ולקבלו בתום הלימודים שם. לא חלה על ההנהלה / הגננת אחריות כלשהי כלפי הילד/ה והוריו על הבאת הילד/ה לגן הילדים ו/או על החזרתו מגן הילדים.</li>
        <li>הגן מתחייב לשמור על שלומו ובטחונו של הילד, לדאוג למזונותיו הסדירים לחינוכו ולהשכלתו בכל שעות הפעילות.</li>
        <li>בשנת הלימודים תעדר הגננת לצורכי לימודים, השתלמויות, חופשות שנתיות הכול בהתאם לתוכניות ולצורכי הפעילות המקצועית והגן.</li>
        <li>בגן קיים ביטוח לילדים אשר מכסה את כל שעות הימצאותו בגן, הביטוח לא יכסה מקרים בהם הילד נמצא בחזקת בן משפחה בדרך לגן או ביציאה מהגן.</li>
        <li>ידוע לצדדים כי בהתאם להנחיית משרד החינוך הורה מתחייב להגיע לגן לקחת את ילדו במקרה של מחלה ח"ו תוך שעה מרגע ההודעה, ובכל מקרה לא יוכל להשיב את הילד לגן ללא אישור רופא כי הבריא.</li>
        <li>ידוע לצדדים כי צוות הגן עשוי להתחלף מעת לעת על פי החלטת הנהלת הגן.</li>
        <li>ההורה ישתתף בכינוסי ההורים ו/או בפגישות שתוזמנה ע"י ההנהלה / הגננת בגן.</li>
        <li>הצדדים יפעלו לקיום קשר תמידי תוך דאגה לחינוכו, בריאותו ורווחתו של הילד/ה וכלל ילדי הגן.</li>
        <li>החזרים כספיים בגין סגירת הגן עקב קורונה ו/או מלחמה – יוחזרו רק במידה והגוף הממשלתי האחראי החליט על סגירה מוחלטת של המסגרת וכנגד, ידע לממן את ההחזרים – תשלומים יוחזרו רק לאחר קבלתם מהגוף הממשלתי.</li>
      </ol>

      <h4>תשלומים:</h4>
      <ol start="17">
        <li>מוסכם בין הצדדים כי שכר הלימוד לחודש יעמוד על סך: ${monthlyFeeStr} כולל חוגים, ימי כיף וגיבוש, וימי שיא. התשלום החודשי ישולם עד לתאריך 09 לכל חודש.</li>
        <li>קייטנות ותוספות עליהם יחליט ועד ההורים או הנהלת הגן ושלא נכללים בתוכנית הלימודים והפעילויות השוטפות בגן – יגבה תשלום נוסף.</li>
        <li>מקדמה לתשלום חודש ראשון: בעת ההרשמה ישלם ההורה מראש להנהלת הגן עבור חודש הלימודים הראשון סך: ${firstMonthStr}. במידה ותבוטל ההרשמה או הילד/ה יעזוב את הגן לפני תחילת הלימודים לא יוחזר סכום זה והוא יהווה פיצוי קבוע ומוסכם לגן בגין הפסקת ההתקשרות.</li>
        <li>תשלום חודש אוגוסט יעמוד על סך ${augFormatted} וישולם במלואו על אף שפעילותו מסתיימת באמצע החודש בתאריך: ${formatDate(endDate)}. לא ניתן לעזוב בחודש זה.</li>
        <li>דמי הרישום והביטוח ע"ס: ${regFeeStr} ישולמו עם רישום הילד/ה לגן ובכל מקרה לא יוחזרו דמי הרישום והביטוח בגין הפסקת ההתקשרות מכל סיבה שהיא.</li>
        <li>בכל איחור שלא סוכם מראש יחויבו ההורים לשלם עבור האיחור ע"פ סך: 90 ₪ לכל שעת איחור או חלק ממנה.</li>
        <li>שכר הלימוד ישולם בתשלומים חודשיים בהוראת קבע - בנק - (31), סניף - (21), חשבון - (760463) - הגן רשאי לעדכן את התשלומים בהתאם לעליית שכר הלימוד / תוספת יוקר המחיה במשך השנה.</li>
      </ol>

      <h4>הפסקת ההתקשרות:</h4>
      <ol start="24">
        <li>על אף האמור לעיל, יהא כל צד רשאי להפסיק את התקשרות תוך מתן הודעה על כך למשנהו, בכתב, לא יאוחר מחודש ימים לפני הפסקת ההתקשרות המתוכננת.</li>
        <li>באם יודיע הגן על הפסקת ההתקשרות – הרי שזו תכנס לתוקפה בתוך חודש מיום הודעת הגן על כך, ובכתב, להורה.</li>
        <li>באם יודיע ההורה על הפסקת ההתקשרות – הרי שישולם על ידו שכר הלימוד עבור אותו חודש בו נתנה ההודעה וכן עבור חודש נוסף שלאחר מכן כפיצוי קבוע ומוסכם מראש.</li>
      </ol>

      ${signature ? `
        <div class="sig-box">
          <p style="margin:0;"><b>חתימת ההורה:</b></p>
          <img src="${signature}" alt="חתימה">
          <p class="sig-meta">${parentName}${parentId ? ` · ת.ז. ${parentId}` : ''} · תאריך: ${today}</p>
        </div>
      ` : ''}
    </body>
    </html>
  `;
}

/**
 * Generate contract as HTML buffer (printed from browser - no puppeteer needed)
 */
async function generateContractPDF(data) {
  const html = generateContractHTML(data);
  return Buffer.from(html, 'utf-8');
}

module.exports = { generateContractHTML, generateContractPDF };
