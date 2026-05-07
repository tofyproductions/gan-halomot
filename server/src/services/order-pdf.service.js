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
// Layout uses tables instead of CSS grid/flex because Google Docs (used by
// the Apps Script HTML→PDF pipeline) ignores most modern CSS — tables and
// inline styles are what survives the conversion.
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

  const supplierRows = [
    `<div><b>שם:</b> ${supplierName}</div>`,
    supplierContact ? `<div><b>איש קשר:</b> ${supplierContact}</div>` : '',
    supplierPhone ? `<div><b>טלפון:</b> ${supplierPhone}</div>` : '',
  ].filter(Boolean).join('');

  const deliveryRows = [
    `<div><b>סניף:</b> ${branchName}</div>`,
    branchAddr ? `<div><b>כתובת:</b> ${branchAddr}</div>` : '',
    deliveryContact ? `<div><b>איש קשר:</b> ${deliveryContact}</div>` : '',
    `<div style="margin-top:4px;padding-top:4px;border-top:1px dashed #cbd5e1;"><b>לקוח משלם:</b> ${customerName}${customerId ? ` · <b>ח.פ:</b> ${customerId}` : ''}</div>`,
  ].filter(Boolean).join('');

  return `
    <table style="width:100%;border-collapse:collapse;margin-bottom:10px;">
      <tr>
        <td style="width:33%;font-size:10px;line-height:1.4;vertical-align:top;">
          <div><b>תאריך:</b> ${date}</div>
          <div><b>שעה:</b> ${time}</div>
          <div><b>מספר הזמנה:</b> ${order.order_number || ''}</div>
        </td>
        <td style="width:34%;text-align:center;vertical-align:top;">
          <div style="color:#d97706;font-size:18px;font-weight:900;line-height:1.1;">גן החלומות</div>
          <div style="font-size:13px;font-weight:800;text-decoration:underline;margin-top:2px;">עבור: ${branchName}</div>
          <div style="color:#475569;font-size:10px;font-weight:700;margin-top:2px;">${variantLabel}</div>
        </td>
        <td style="width:33%;text-align:left;vertical-align:top;">
          ${LOGO_DATA_URL ? `<img src="${LOGO_DATA_URL}" alt="" style="width:60px;height:auto;">` : ''}
        </td>
      </tr>
    </table>

    <table style="width:100%;border-collapse:separate;border-spacing:8px 0;margin-bottom:8px;">
      <tr>
        <td style="width:50%;border:1px solid #cbd5e1;padding:8px 10px;vertical-align:top;font-size:10px;line-height:1.5;">
          <div style="font-weight:800;font-size:11px;border-bottom:1px solid #e2e8f0;padding-bottom:3px;margin-bottom:4px;">פרטי ספק</div>
          ${supplierRows}
        </td>
        <td style="width:50%;border:1px solid #cbd5e1;padding:8px 10px;vertical-align:top;font-size:10px;line-height:1.5;">
          <div style="font-weight:800;font-size:11px;border-bottom:1px solid #e2e8f0;padding-bottom:3px;margin-bottom:4px;">כתובת למשלוח</div>
          ${deliveryRows}
        </td>
      </tr>
    </table>
  `;
}

const SHARED_CSS = `
  @page { size: A4; margin: 10mm; }
  body { font-family: Arial, sans-serif; color: #1e293b; direction: rtl; margin: 0; padding: 0; font-size: 10px; }
  table.items { width: 100%; border-collapse: collapse; font-size: 10px; margin-top: 6px; }
  table.items th, table.items td { padding: 4px 6px; border: 1px solid #cbd5e1; text-align: center; }
  table.items th { background: #f1f5f9; font-weight: 800; color: #1e293b; }
  table.items td.product { text-align: right; font-weight: 600; }
  .total-box { margin-top: 10px; padding: 8px 14px; border: 2px solid #10b981; display: inline-block; font-size: 13px; font-weight: 800; color: #065f46; background: #f0fdf4; }
  .footer { margin-top: 14px; padding-top: 6px; border-top: 1px solid #e2e8f0; color: #94a3b8; font-size: 9px; text-align: center; }
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
