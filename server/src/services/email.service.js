const nodemailer = require('nodemailer');
const env = require('../config/env');

let transporter = null;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: false,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    });
  }
  return transporter;
}

/**
 * Send registration completion email with contract PDF and uploaded docs
 */
async function sendAgreementEmail({ childName, parentName, parentEmail, contractPdfBuffer, attachments = [] }) {
  const officeEmail = 'tofy10.office@gmail.com';
  const recipients = [officeEmail, parentEmail].filter(Boolean).join(',');

  const htmlBody = `
    <div dir="rtl" style="font-family: Arial, sans-serif;">
      <h2>שלום משפחת ${parentName},</h2>
      <p>מצורף בזאת עותק חתום של הסכם ההתקשרות עבור <b>${childName}</b>.</p>
      <p><b>המסמכים המצורפים:</b></p>
      <ul>
        <li>חוזה התקשרות חתום</li>
        <li>כרטסת פרטים אישיים</li>
        ${attachments.map(a => `<li>${a.filename}</li>`).join('')}
      </ul>
      <hr>
      <p>בברכה,<br>הנהלת גן החלומות</p>
    </div>
  `;

  const mailAttachments = [];
  if (contractPdfBuffer) {
    mailAttachments.push({
      filename: `Agreement_${childName}.pdf`,
      content: contractPdfBuffer,
      contentType: 'application/pdf',
    });
  }
  attachments.forEach(a => mailAttachments.push(a));

  await getTransporter().sendMail({
    to: recipients,
    subject: `סיום רישום והסכם חתום - ${childName}`,
    html: htmlBody,
    attachments: mailAttachments,
  });
}

/**
 * Send registration link to parent via email
 */
async function sendRegistrationLink({ parentName, parentEmail, childName, link }) {
  const htmlBody = `
    <div dir="rtl" style="font-family: Arial, sans-serif;">
      <h2>שלום ${parentName},</h2>
      <p>שמחים שהצטרפתם לגן החלומות! 🌟</p>
      <p>להשלמת הרישום של <b>${childName}</b>, אנא היכנסו לקישור הבא:</p>
      <p style="text-align:center; margin:30px 0;">
        <a href="${link}" style="background:#fbbf24; color:#1e293b; padding:15px 40px; border-radius:30px; text-decoration:none; font-weight:bold; font-size:1.1rem;">
          להשלמת הרישום לחצו כאן
        </a>
      </p>
      <p>בברכה,<br>הנהלת גן החלומות</p>
    </div>
  `;

  await getTransporter().sendMail({
    to: parentEmail,
    subject: `השלמת רישום - ${childName} - גן החלומות`,
    html: htmlBody,
  });
}

module.exports = { sendAgreementEmail, sendRegistrationLink };
