/**
 * Import שבי מזון price list from Google Sheets into MongoDB
 * Usage: node scripts/import-pricelist.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const https = require('https');

const SHEET_ID = '17m9QvVQSUgtyOMMK7M91WBdCL8HmfOTWDZcQ6ErFKpY';
const SHEET_NAME = 'מחירון שבי';

function fetchCSV(sheetName) {
  const encoded = encodeURIComponent(sheetName);
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encoded}`;
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        https.get(res.headers.location, (res2) => {
          let data = ''; res2.on('data', c => data += c); res2.on('end', () => resolve(data));
        }).on('error', reject);
        return;
      }
      let data = ''; res.on('data', c => data += c); res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function parseCSV(text) {
  const rows = [];
  const lines = [];
  let current = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') { inQ = !inQ; current += '"'; }
    else if (text[i] === '\n' && !inQ) { lines.push(current); current = ''; }
    else current += text[i];
  }
  if (current.trim()) lines.push(current);

  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = []; let cell = '', q = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') { if (q && line[i+1] === '"') { cell += '"'; i++; } else q = !q; }
      else if (line[i] === ',' && !q) { cols.push(cell); cell = ''; }
      else cell += line[i];
    }
    cols.push(cell);
    rows.push(cols);
  }
  return rows;
}

async function run() {
  console.log('📦 Importing שבי מזון price list...\n');

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ Connected to MongoDB');

  const { Supplier, Product } = require('../src/models');

  // Find or create supplier
  let supplier = await Supplier.findOne({ name: 'שבי - שיווק מזון' });
  if (!supplier) {
    supplier = await Supplier.create({
      name: 'שבי - שיווק מזון',
      contact_name: 'מאיר', contact_phone: '052-5075834',
      customer_name: 'גן החלומות', customer_id: '580757805',
      min_order_amount: 1200, vat_rate: 1.18,
    });
    console.log('Created supplier');
  }

  const VAT = supplier.vat_rate || 1.18;

  // Fetch price list
  const csv = await fetchCSV(SHEET_NAME);
  const rows = parseCSV(csv);

  console.log(`Found ${rows.length - 1} product rows\n`);

  // Skip header row: שורה, מק"ט, קטגוריה, תאור (פריט), מחיר נוכחי
  let imported = 0;
  let skipped = 0;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const sku = (row[1] || '').trim();
    const category = (row[2] || '').trim();
    const name = (row[3] || '').trim();
    const priceStr = (row[4] || '').trim();

    if (!name || !priceStr) continue;

    const price = parseFloat(priceStr);
    if (isNaN(price)) continue;

    // Check if product already exists
    const existing = await Product.findOne({ supplier_id: supplier._id, sku, name });
    if (existing) {
      // Update price if changed
      if (existing.price_before_vat !== price) {
        existing.price_before_vat = price;
        existing.price_with_vat = Number((price * VAT).toFixed(2));
        await existing.save();
      }
      skipped++;
      continue;
    }

    await Product.create({
      supplier_id: supplier._id,
      sku, category, name,
      price_before_vat: price,
      price_with_vat: Number((price * VAT).toFixed(2)),
    });
    imported++;
  }

  console.log(`✅ Imported: ${imported} new products`);
  console.log(`⏭️ Skipped: ${skipped} existing products`);
  console.log(`📦 Total products for שבי: ${await Product.countDocuments({ supplier_id: supplier._id, is_active: true })}`);

  await mongoose.disconnect();
  process.exit(0);
}

run().catch(err => { console.error('❌ Error:', err); process.exit(1); });
