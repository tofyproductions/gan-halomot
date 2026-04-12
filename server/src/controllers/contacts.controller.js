const db = require('../config/database');
const puppeteer = require('puppeteer');

/**
 * GET /api/contacts/pdf?classroom=1
 * Generate a contact list PDF grouped by classroom
 */
async function generatePDF(req, res, next) {
  try {
    const { classroom } = req.query;

    let query = db('children')
      .select(
        'children.child_name',
        'children.parent_name',
        'children.phone',
        'children.email',
        'children.medical_alerts',
        'classrooms.name as classroom_name'
      )
      .leftJoin('classrooms', 'children.classroom_id', 'classrooms.id')
      .where('children.is_active', true)
      .orderBy('classrooms.name')
      .orderBy('children.child_name');

    if (classroom) {
      query = query.where('children.classroom_id', classroom);
    }

    const children = await query;

    if (children.length === 0) {
      return res.status(404).json({ error: 'No children found for contact list' });
    }

    // Group by classroom
    const grouped = {};
    for (const child of children) {
      const groupName = child.classroom_name || 'ללא קבוצה';
      if (!grouped[groupName]) {
        grouped[groupName] = [];
      }
      grouped[groupName].push(child);
    }

    // Generate HTML
    const today = new Date().toLocaleDateString('he-IL');
    let html = `
      <!DOCTYPE html>
      <html dir="rtl" lang="he">
      <head>
        <meta charset="UTF-8">
        <style>
          body { font-family: 'Assistant', 'Heebo', Arial, sans-serif; max-width: 900px; margin: 0 auto; padding: 40px; color: #0f172a; }
          h1 { text-align: center; color: #1e3a8a; font-size: 1.8rem; margin-bottom: 5px; }
          .date { text-align: center; color: #64748b; margin-bottom: 30px; }
          h2 { color: #1e3a8a; border-bottom: 2px solid #3b82f6; padding-bottom: 5px; margin-top: 30px; }
          table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
          th { background: #1e3a8a; color: white; padding: 10px 8px; text-align: right; font-size: 0.9rem; }
          td { padding: 8px; border-bottom: 1px solid #e2e8f0; font-size: 0.9rem; }
          tr:nth-child(even) { background: #f8fafc; }
          .count { color: #64748b; font-size: 0.85rem; }
          @media print { body { padding: 20px; } }
        </style>
      </head>
      <body>
        <h1>רשימת אנשי קשר - גן החלומות</h1>
        <p class="date">תאריך הפקה: ${today}</p>
    `;

    for (const [classroomName, kids] of Object.entries(grouped)) {
      html += `
        <h2>${classroomName} <span class="count">(${kids.length} ילדים)</span></h2>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>שם הילד/ה</th>
              <th>שם ההורה</th>
              <th>טלפון</th>
              <th>אימייל</th>
            </tr>
          </thead>
          <tbody>
      `;

      kids.forEach((kid, idx) => {
        html += `
          <tr>
            <td>${idx + 1}</td>
            <td>${kid.child_name}</td>
            <td>${kid.parent_name}</td>
            <td>${kid.phone || '-'}</td>
            <td>${kid.email || '-'}</td>
          </tr>
        `;
      });

      html += `
          </tbody>
        </table>
      `;
    }

    html += `
      </body>
      </html>
    `;

    // Convert to PDF using Puppeteer
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0' });
      const pdfBuffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '15mm', bottom: '15mm', left: '10mm', right: '10mm' },
      });

      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="contacts_${Date.now()}.pdf"`,
        'Content-Length': pdfBuffer.length,
      });
      res.end(pdfBuffer);
    } finally {
      await browser.close();
    }
  } catch (error) {
    next(error);
  }
}

module.exports = { generatePDF, generatePdf: generatePDF };
