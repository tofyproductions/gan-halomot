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

/**
 * Build the HTML body for an order — used for both supplier emails and
 * the creator's confirmation copy. The same markup is also what the client
 * "הדפס/שמור PDF" button renders, so what the supplier sees and what the
 * user prints stay aligned.
 */
function buildOrderHTML({ order, supplier, branch, creatorName }) {
  const fmtCurrency = (n) => `₪${Number(n || 0).toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const today = new Date(order.created_at || Date.now()).toLocaleDateString('he-IL');

  const itemsHTML = (order.items || []).map(it => `
    <tr>
      <td style="padding:8px;border:1px solid #e2e8f0;">${it.sku || ''}</td>
      <td style="padding:8px;border:1px solid #e2e8f0;font-weight:600;">${it.name || ''}</td>
      <td style="padding:8px;border:1px solid #e2e8f0;text-align:center;font-weight:700;">${it.qty || 0}</td>
      <td style="padding:8px;border:1px solid #e2e8f0;text-align:center;">${fmtCurrency(it.unit_price)}</td>
      <td style="padding:8px;border:1px solid #e2e8f0;text-align:center;font-weight:700;">${fmtCurrency(it.total)}</td>
    </tr>
  `).join('');

  return `
    <div dir="rtl" style="font-family: 'Assistant', Arial, sans-serif; color:#1e293b; max-width:800px; margin:0 auto; padding:20px;">
      <div style="border-bottom:3px solid #f59e0b; padding-bottom:16px; margin-bottom:24px;">
        <h1 style="margin:0;color:#d97706;font-size:28px;">הזמנה ${order.order_number}</h1>
        <p style="margin:8px 0 0;color:#64748b;">${today}</p>
      </div>

      <table style="width:100%; margin-bottom:24px; border-collapse:collapse;">
        <tr>
          <td style="padding:12px;background:#f8fafc;border-radius:8px;width:50%;vertical-align:top;">
            <div style="color:#64748b;font-size:13px;">ספק</div>
            <div style="font-weight:700;font-size:16px;">${supplier?.name || ''}</div>
            ${supplier?.contact_name ? `<div style="color:#475569;">${supplier.contact_name}${supplier.contact_phone ? ' · ' + supplier.contact_phone : ''}</div>` : ''}
            ${supplier?.contact_email ? `<div style="color:#475569;">${supplier.contact_email}</div>` : ''}
          </td>
          <td style="padding:12px;background:#fffbeb;border-radius:8px;width:50%;vertical-align:top;">
            <div style="color:#64748b;font-size:13px;">סניף מזמין</div>
            <div style="font-weight:700;font-size:16px;">${branch?.name || ''}</div>
            ${branch?.address ? `<div style="color:#475569;">${branch.address}</div>` : ''}
            ${creatorName ? `<div style="color:#475569;">הזמין: ${creatorName}</div>` : ''}
          </td>
        </tr>
      </table>

      ${order.notes ? `<div style="padding:12px;background:#dbeafe;border-radius:8px;margin-bottom:16px;"><b>הערות:</b> ${order.notes}</div>` : ''}

      <table style="width:100%; border-collapse:collapse; font-size:14px;">
        <thead>
          <tr style="background:#f8fafc;">
            <th style="padding:10px;border:1px solid #e2e8f0;text-align:right;">מק"ט</th>
            <th style="padding:10px;border:1px solid #e2e8f0;text-align:right;">מוצר</th>
            <th style="padding:10px;border:1px solid #e2e8f0;text-align:center;">כמות</th>
            <th style="padding:10px;border:1px solid #e2e8f0;text-align:center;">מחיר ליח'</th>
            <th style="padding:10px;border:1px solid #e2e8f0;text-align:center;">סה"כ</th>
          </tr>
        </thead>
        <tbody>${itemsHTML}</tbody>
        <tfoot>
          <tr>
            <td colspan="4" style="padding:12px;border:1px solid #e2e8f0;text-align:left;font-weight:800;font-size:16px;background:#fef3c7;">סה"כ להזמנה</td>
            <td style="padding:12px;border:1px solid #e2e8f0;text-align:center;font-weight:800;font-size:16px;background:#fef3c7;">${fmtCurrency(order.total_amount)}</td>
          </tr>
        </tfoot>
      </table>

      <div style="margin-top:32px; padding-top:16px; border-top:1px solid #e2e8f0; color:#94a3b8; font-size:13px; text-align:center;">
        גן החלומות · נשלח אוטומטית ממערכת ההזמנות
      </div>
    </div>
  `;
}

/**
 * Send the order to the supplier (and BCC the creator + office).
 * Skips silently if SMTP isn't configured or the supplier has no email —
 * the OrderView still shows the order, the user just won't get a copy in
 * their inbox.
 */
async function sendOrderEmail({ order, supplier, branch, creatorEmail, creatorName }) {
  if (!env.SMTP_USER) {
    console.warn('SMTP not configured — skipping order email');
    return { skipped: true, reason: 'smtp-not-configured' };
  }

  const supplierEmail = supplier?.contact_email;
  const officeEmail = 'tofy10.office@gmail.com';
  const recipients = [supplierEmail, creatorEmail, officeEmail].filter(Boolean);
  if (recipients.length === 0) {
    return { skipped: true, reason: 'no-recipients' };
  }

  const html = buildOrderHTML({ order, supplier, branch, creatorName });

  const info = await getTransporter().sendMail({
    from: `"גן החלומות" <${env.SMTP_USER}>`,
    to: supplierEmail || creatorEmail,
    cc: [creatorEmail, officeEmail].filter(e => e && e !== supplierEmail).join(','),
    subject: `הזמנה ${order.order_number} · ${branch?.name || ''} · ${supplier?.name || ''}`,
    html,
  });

  return { sent: true, messageId: info.messageId, recipients };
}

module.exports = { sendAgreementEmail, sendRegistrationLink, sendOrderEmail, buildOrderHTML };
