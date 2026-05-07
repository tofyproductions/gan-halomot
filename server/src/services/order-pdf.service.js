const fs = require('fs');
const path = require('path');

// Cache the kindergarten logo as a data URL the same way the contract PDF
// service does. Falls back to no logo if the asset is missing.
let LOGO_DATA_URL = null;
try {
  const logoPath = path.join(__dirname, '..', 'assets', 'logo.png');
  if (fs.existsSync(logoPath)) {
    const buf = fs.readFileSync(logoPath);
    LOGO_DATA_URL = `data:image/png;base64,${buf.toString('base64')}`;
  }
} catch (err) {
  console.error('Failed to load order PDF logo:', err.message);
}

function fmt(n) {
  return Number(n || 0).toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  return `${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}/${dt.getFullYear()}`;
}

function fmtTime(d) {
  if (!d) return '';
  const dt = new Date(d);
  return `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
}

// Shared header + side boxes for both PDFs. Variant: 'supplier' | 'internal'.
function topBlock({ order, supplier, branch, variant }) {
  const date = fmtDate(order.created_at);
  const time = fmtTime(order.created_at);
  const variantLabel = variant === 'supplier' ? 'הזמנת רכש (לספק)' : 'הזמנת רכש (פנימית)';

  const supplierName = supplier?.name || '';
  const supplierContact = supplier?.contact_name || '';
  const supplierPhone = supplier?.contact_phone || '';

  const branchName = branch?.name || '';
  const branchAddr = branch?.address || '';
  const deliveryContact = [branch?.delivery_contact_name, branch?.delivery_contact_phone]
    .filter(Boolean).join(' - ');

  const customerName = supplier?.customer_name || 'גן החלומות';
  const customerId = supplier?.customer_id || '';

  return `
    <header class="doc-head">
      <div class="head-meta">
        <div><b>תאריך:</b> ${date}</div>
        <div><b>שעה:</b> ${time}</div>
        <div><b>מספר הזמנה:</b> ${order.order_number || ''}</div>
      </div>
      <div class="head-title">
        <h1>גן החלומות</h1>
        <h2>עבור: ${branchName}</h2>
        <div class="subtitle">${variantLabel}</div>
      </div>
      ${LOGO_DATA_URL ? `<img class="head-logo" src="${LOGO_DATA_URL}" alt="">` : ''}
    </header>

    <section class="info-grid">
      <div class="info-card">
        <h3>פרטי ספק</h3>
        <div><b>שם:</b> ${supplierName}</div>
        ${supplierContact ? `<div><b>איש קשר:</b> ${supplierContact}</div>` : ''}
        ${supplierPhone ? `<div><b>טלפון:</b> ${supplierPhone}</div>` : ''}
      </div>
      <div class="info-card">
        <h3>כתובת למשלוח</h3>
        <div><b>סניף:</b> ${branchName}</div>
        ${branchAddr ? `<div><b>כתובת:</b> ${branchAddr}</div>` : ''}
        ${deliveryContact ? `<div><b>איש קשר:</b> ${deliveryContact}</div>` : ''}
        <hr>
        <div><b>לקוח משלם:</b> ${customerName}</div>
        ${customerId ? `<div><b>ח.פ:</b> ${customerId}</div>` : ''}
      </div>
    </section>
  `;
}

const SHARED_CSS = `
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Assistant', 'Heebo', Arial, sans-serif; color: #1e293b; direction: rtl; margin: 0; padding: 16px; }
  .doc-head { display: flex; align-items: center; justify-content: space-between; padding-bottom: 16px; border-bottom: 3px solid #10b981; margin-bottom: 20px; }
  .head-meta { font-size: 12px; line-height: 1.6; min-width: 160px; }
  .head-title { text-align: center; flex: 1; }
  .head-title h1 { margin: 0; color: #d97706; font-size: 28px; font-weight: 900; }
  .head-title h2 { margin: 4px 0; color: #1e293b; font-size: 18px; font-weight: 800; text-decoration: underline; }
  .head-title .subtitle { color: #475569; font-weight: 700; font-size: 14px; }
  .head-logo { width: 90px; height: auto; }
  .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px; }
  .info-card { border: 1px solid #cbd5e1; border-radius: 12px; padding: 14px 16px; font-size: 13px; line-height: 1.7; }
  .info-card h3 { margin: 0 0 8px 0; font-size: 14px; color: #1e293b; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px; }
  .info-card hr { border: none; border-top: 1px dashed #e2e8f0; margin: 8px 0; }
  table.items { width: 100%; border-collapse: collapse; font-size: 13px; }
  table.items th, table.items td { padding: 8px 6px; border: 1px solid #cbd5e1; text-align: center; }
  table.items th { background: #f8fafc; font-weight: 800; color: #475569; }
  table.items td.product { text-align: right; font-weight: 600; }
  .total-box { margin-top: 18px; padding: 14px 18px; border: 2px solid #10b981; border-radius: 12px; display: inline-block; font-size: 18px; font-weight: 800; color: #065f46; background: #f0fdf4; }
  .footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid #e2e8f0; color: #94a3b8; font-size: 11px; text-align: center; }
`;

function buildSupplierHTML({ order, supplier, branch }) {
  const itemsHTML = (order.items || []).map(it => `
    <tr>
      <td>${it.sku || ''}</td>
      <td class="product">${it.name || ''}</td>
      <td><b>${it.qty || 0}</b></td>
    </tr>
  `).join('');

  return `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8">
    <title>הזמנה לספק ${order.order_number}</title>
    <style>${SHARED_CSS}</style>
  </head><body>
    ${topBlock({ order, supplier, branch, variant: 'supplier' })}
    <table class="items">
      <thead><tr>
        <th style="width: 80px">מק"ט</th>
        <th>תיאור מוצר</th>
        <th style="width: 80px">כמות</th>
      </tr></thead>
      <tbody>${itemsHTML}</tbody>
    </table>
    <div class="footer">מסמך זה הופק באופן ממוחשב | מערכת הזמנות גן החלומות</div>
  </body></html>`;
}

function buildInternalHTML({ order, supplier, branch }) {
  const itemsHTML = (order.items || []).map(it => `
    <tr>
      <td>${it.sku || ''}</td>
      <td class="product">${it.name || ''}</td>
      <td><b>${it.qty || 0}</b></td>
      <td>${fmt(it.unit_price)}</td>
      <td><b>${fmt(it.total)}</b></td>
    </tr>
  `).join('');

  return `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8">
    <title>הזמנה פנימית ${order.order_number}</title>
    <style>${SHARED_CSS}</style>
  </head><body>
    ${topBlock({ order, supplier, branch, variant: 'internal' })}
    <table class="items">
      <thead><tr>
        <th style="width: 80px">מק"ט</th>
        <th>תיאור מוצר</th>
        <th style="width: 60px">כמות</th>
        <th style="width: 80px">מחיר יח'</th>
        <th style="width: 90px">סה"כ</th>
      </tr></thead>
      <tbody>${itemsHTML}</tbody>
    </table>
    <div class="total-box">סה"כ לתשלום: ${fmt(order.total_amount)} ₪</div>
    <div class="footer">מסמך זה הופק באופן ממוחשב | מערכת הזמנות גן החלומות</div>
  </body></html>`;
}

// Filename like the old system: "הזמנה_לספק_<branch>_DD-MM-YYYY.pdf"
function buildFilename({ variant, branch, order }) {
  const branchName = (branch?.name || 'סניף').replace(/[\\/:*?"<>|]/g, '');
  const d = new Date(order.created_at || Date.now());
  const date = `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
  const label = variant === 'supplier' ? 'לספק' : 'פנימית';
  return `הזמנה_${label}_${branchName}_${date}`;
}

module.exports = { buildSupplierHTML, buildInternalHTML, buildFilename };
