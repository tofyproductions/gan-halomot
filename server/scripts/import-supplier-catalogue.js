#!/usr/bin/env node
/**
 * Load a supplier and its catalogue into a RUNNING server, over the API.
 *
 * WHY OVER THE API AND NOT INTO MONGO. The obvious version of this script
 * connects to the database and inserts. It is also the version that writes rows
 * no controller has ever agreed to: no VAT recalculated from the supplier's own
 * rate, no dedupe on item code, nothing the write guard can see. Going through
 * POST /api/suppliers and POST /api/products/import means this file cannot
 * create anything the app could not create itself, and the day the product
 * shape changes, it changes here too because it changes there.
 *
 * It is also the reason this is safe to point at production: it holds a token,
 * so it can do exactly what the person who issued that token can do.
 *
 *   node scripts/import-supplier-catalogue.js <catalogue.json> \
 *     --api https://gan-halomot.onrender.com --token <JWT>
 *
 *   --dry-run   say what would happen and write nothing (default)
 *   --apply     actually write
 *
 * The catalogue file is { supplier: {...}, products: [ {sku, name, unit,
 * price_before_vat, image_data}, ... ] } — see the extractor that produces it.
 *
 * Re-running is safe and is the point: an existing supplier of the same name is
 * reused rather than duplicated, and /products/import updates a code it already
 * holds instead of adding a second row for it. Sending next quarter's price list
 * through the same command is how prices get updated.
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const flag = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const API = (flag('api') || 'http://localhost:3001').replace(/\/$/, '');
const TOKEN = flag('token') || process.env.GAN_TOKEN || '';
const APPLY = args.includes('--apply');

if (!file) {
  console.error('שימוש: node scripts/import-supplier-catalogue.js <catalogue.json> --api <url> --token <jwt> [--apply]');
  process.exit(1);
}
if (!TOKEN) {
  console.error('חסר טוקן. --token <jwt>  או  GAN_TOKEN=<jwt>');
  process.exit(1);
}

async function call(method, route, body) {
  const res = await fetch(`${API}/api${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* an HTML error page, kept as text */ }
  if (!res.ok) {
    throw new Error(`${method} ${route} → ${res.status} ${parsed?.error || text.slice(0, 200)}`);
  }
  return parsed;
}

/**
 * Pictures are the bulk of the payload — 41 of them is about 400KB — and one
 * request carrying all of it is one request to lose. Sent in batches, which
 * also means a failure halfway names the batch it stopped on.
 */
const BATCH = 10;

async function main() {
  const cat = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  const { supplier, products } = cat;
  if (!supplier?.name || !Array.isArray(products)) {
    throw new Error('הקובץ חייב להכיל supplier.name ומערך products');
  }

  const withImg = products.filter(p => p.image_data).length;
  const bytes = products.reduce((n, p) => n + (p.image_data?.length || 0), 0);
  console.log(`\n=== ${supplier.name} ===`);
  console.log(`שרת:      ${API}`);
  console.log(`מוצרים:   ${products.length} (${withImg} עם תמונה, ${(bytes / 1024 / 1024).toFixed(1)}MB)`);
  console.log(`מצב:      ${APPLY ? 'כתיבה אמיתית' : 'הרצה יבשה — לא ייכתב דבר'}\n`);

  // Which supplier. Matched on the name, because that is what a person typing
  // it again would match on, and a second "דאלאס מוצרי נייר" beside the first
  // is the failure this is avoiding.
  const { suppliers = [] } = await call('GET', '/suppliers');
  const existing = suppliers.find(s => s.name.trim() === supplier.name.trim());
  if (existing) console.log(`ספק קיים — משתמש בו: ${existing.name} (${existing._id || existing.id})`);
  else console.log(`ספק חדש ייווצר: ${supplier.name}`);

  const { products: current = [] } = existing
    ? await call('GET', `/products?supplier=${existing._id || existing.id}`)
    : { products: [] };
  const have = new Set(current.map(p => p.sku).filter(Boolean));
  const fresh = products.filter(p => !have.has(String(p.sku))).length;
  console.log(`מתוכם: ${fresh} חדשים, ${products.length - fresh} כבר קיימים ויעודכנו\n`);

  if (!APPLY) {
    console.log('הרצה יבשה הסתיימה. להרצה אמיתית הוסף --apply\n');
    return;
  }

  const supplierId = existing
    ? (existing._id || existing.id)
    : (await call('POST', '/suppliers', supplier)).supplier?._id
      || (await call('GET', '/suppliers')).suppliers.find(s => s.name === supplier.name)._id;

  let added = 0;
  let updated = 0;
  for (let i = 0; i < products.length; i += BATCH) {
    const slice = products.slice(i, i + BATCH);
    const r = await call('POST', '/products/import', { supplier_id: supplierId, products: slice });
    added += r.count || 0;
    updated += r.updated || 0;
    console.log(`  ${Math.min(i + BATCH, products.length)}/${products.length} — ${r.message}`);
  }

  console.log(`\n✅ ${supplier.name}: ${added} נוספו, ${updated} עודכנו\n`);
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}\n`);
  process.exit(1);
});
