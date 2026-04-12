const { calculateFirstMonthPayment, calculateAugustPayment } = require('./prorate.service');
const { getHebrewYear } = require('./academic-year.service');

/**
 * Generate contract HTML string from registration data
 */
function generateContractHTML(data) {
  const today = new Date().toLocaleDateString('he-IL');
  const schoolYear = getHebrewYear(data.start_date || data.startDate);

  const augCalc = calculateAugustPayment(data.monthly_fee || data.monthlyFee, data.start_date || data.startDate);
  const augAmount = parseFloat(augCalc.total).toLocaleString('he-IL', { style: 'currency', currency: 'ILS' });
  const augNote = augCalc.isProrated ? `(חישוב יחסי ל-${augCalc.months} חודשי פעילות מתוך 12)` : '';

  const firstMonth = calculateFirstMonthPayment(data.monthly_fee || data.monthlyFee, data.start_date || data.startDate);

  const formatDate = (d) => {
    if (!d) return '';
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return d;
    return `${String(dt.getDate()).padStart(2, '0')}.${String(dt.getMonth() + 1).padStart(2, '0')}.${dt.getFullYear()}`;
  };

  const childName = data.child_name || data.childName || '';
  const parentName = data.parent_name || data.parentName || '';
  const parentId = data.parent_id_number || data.parentId || '';
  const classroom = data.classroom || '';
  const monthlyFee = data.monthly_fee || data.monthlyFee || 0;
  const regFee = data.registration_fee || data.regFee || 500;
  const startDate = data.start_date || data.startDate;
  const endDate = data.end_date || data.endDate;
  const startTime = data.startTime || '07:00';
  const endTime = data.endTime || '17:00';
  const friTime = data.friTime || '07:30-12:00';
  const signature = data.signature_data || data.signature || '';

  const config = (typeof data.configuration === 'string' ? JSON.parse(data.configuration || '{}') : data.configuration) || {};

  return `
    <!DOCTYPE html>
    <html dir="rtl" lang="he">
    <head>
      <meta charset="UTF-8">
      <style>
        body { font-family: 'Assistant', 'Heebo', sans-serif; max-width: 900px; margin: 0 auto; line-height: 1.6; color: #0f172a; padding: 60px; }
        h1 { text-align: center; color: #1e3a8a; font-size: 2rem; }
        h4 { color: #1e3a8a; text-decoration: underline; margin-top: 20px; }
        ol { padding-right: 20px; }
        li { margin-bottom: 8px; }
        .summary { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; margin: 20px 0; display: flex; gap: 30px; flex-wrap: wrap; justify-content: center; }
        .sig-box { margin-top: 40px; border: 3px solid #3b82f6; padding: 25px; border-radius: 15px; display: inline-block; }
        .sig-box img { max-width: 300px; }
      </style>
    </head>
    <body>
      <h1>הסכם התקשרות ורישום - שנה"ל ${schoolYear}</h1>
      <div class="summary">
        <div><b>ילד/ה:</b> ${childName}</div>
        <div><b>הורה:</b> ${parentName}</div>
        <div><b>קבוצה:</b> ${classroom}</div>
        <div><b>תאריך חתימה:</b> ${today}</div>
      </div>

      <h4>ההתקשרות:</h4>
      <ol>
        <li>ההורה מתקשר עם הגננת לקבלת שרותי גן לבנו/לביתו: <b>${childName}</b> לכיתת <b>${classroom}</b>.</li>
        <li>תקופת הלימודים: <b>${formatDate(startDate)}</b> עד <b>${formatDate(endDate)}</b>.</li>
        <li>שעות פעילות: <b>${startTime}</b> עד <b>${endTime}</b>, ימי שישי: <b>${friTime}</b>.</li>
        <li>שכ"ל מקנה זכות לימוד בשעות ובימים הקבועים ע"פ הנחיות משרד החינוך.</li>
        <li>הגן סגור בימי חג, שבתון וחופשה ע"פ משרד החינוך.</li>
        <li>שכ"ל ישולם גם בתקופת היעדרות מכל סיבה.</li>
        <li>ההורה ישא בתשלומי ביטוח תאונות (כלול בדמי רישום).</li>
        <li>ההורה אחראי להביא ולאסוף את הילד.</li>
        <li>הגן מתחייב לשמור על שלום הילד ולדאוג למזונותיו.</li>
        <li>הגננת תיעדר לצורכי השתלמויות בהתאם לצרכים.</li>
        <li>בגן ביטוח לילדים בשעות הפעילות בלבד.</li>
        <li>ההורה מתחייב להגיע תוך שעה במקרה מחלה.</li>
        <li>צוות הגן עשוי להתחלף.</li>
        <li>ההורה ישתתף בכינוסי הורים.</li>
        <li>הצדדים ישמרו על קשר לטובת חינוך ורווחת הילד.</li>
        <li>החזרים כספיים בגין סגירה ממשלתית - רק לאחר קבלת מימון.</li>
      </ol>

      <h4>תשלומים:</h4>
      <ol start="17">
        <li>שכ"ל חודשי: <b>${monthlyFee} ₪</b> כולל חוגים. תשלום עד ה-9 לכל חודש.</li>
        <li>קייטנות ותוספות - תשלום נוסף.</li>
        <li>מקדמה לחודש ראשון: <b>${firstMonth.fee} ₪</b> ${firstMonth.note ? `(${firstMonth.note})` : ''}.</li>
        <li>תשלום אוגוסט: <b>${augAmount}</b> ${augNote}.</li>
        <li>דמי רישום וביטוח: <b>${regFee} ₪</b> - לא יוחזרו.</li>
        <li>איחור: <b>90 ₪</b> לכל שעה.</li>
        <li>תשלום בהוראת קבע - בנק 31, סניף 21, חשבון 760463.</li>
      </ol>

      <h4>הפסקת ההתקשרות:</h4>
      <ol start="24">
        <li>כל צד רשאי להפסיק בהודעה כתובה חודש מראש.</li>
        <li>הודעת הגן - תוקף תוך חודש.</li>
        <li>הודעת ההורה - תשלום לחודש הנוכחי + חודש נוסף כפיצוי.</li>
      </ol>

      ${signature ? `
        <div class="sig-box">
          <p><b>חתימת ההורה:</b></p>
          <img src="${signature}" alt="חתימה">
          <p style="font-size:0.85rem; color:#64748b;">תאריך: ${today}</p>
        </div>
      ` : ''}
    </body>
    </html>
  `;
}

/**
 * Generate PDF buffer from registration data
 * Uses @sparticuz/chromium for Vercel compatibility (no full puppeteer)
 */
async function generateContractPDF(data) {
  const html = generateContractHTML(data);

  try {
    // Try Vercel-compatible chromium first
    const chromium = require('@sparticuz/chromium');
    const puppeteer = require('puppeteer-core');

    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
    });
    await browser.close();
    return pdfBuffer;
  } catch (err) {
    console.warn('PDF generation not available:', err.message);
    // Fallback: return HTML as buffer (can be printed from browser)
    return Buffer.from(html, 'utf-8');
  }
}

module.exports = { generateContractHTML, generateContractPDF };
