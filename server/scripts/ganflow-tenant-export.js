#!/usr/bin/env node
/**
 * Take one customer's data out of the system, as files.
 *
 * WHY IT IS A COMMAND AND NOT A BUTTON. Two different situations need this and
 * neither is a click: a customer who is leaving and is entitled to their own
 * records, and the moment before somebody deletes a customer for good. Both
 * want a file that exists on disk afterwards and can be checked, not a download
 * that may or may not have finished.
 *
 * It reads and never writes. The customer's database is untouched, which is the
 * whole point when the next step is destructive.
 *
 * One JSON file per collection, plus a manifest with the counts. The manifest
 * is what makes the export checkable: "did we get everything" is answered by
 * comparing numbers rather than by trusting that the command finished. An
 * export whose completeness cannot be verified is not a backup, it is a hope.
 *
 *   node scripts/ganflow-tenant-export.js --slug shachar --out ~/exports
 *   node scripts/ganflow-tenant-export.js --slug shachar --out ~/exports --verify
 *
 * Requires PLATFORM_MONGODB_URI — the customer registry is where the database
 * address lives.
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config();

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const SLUG = opt('slug');
const OUT = opt('out');
const VERIFY_ONLY = argv.includes('--verify');

function die(m) { console.error(`\n❌  ${m}\n`); process.exit(1); }

if (!SLUG) die('חסר --slug');
if (!OUT) die('חסר --out — לאיזו תיקייה לכתוב');
if (!process.env.PLATFORM_MONGODB_URI) die('חסר PLATFORM_MONGODB_URI');

(async () => {
  const { controlPlane, tenantConnection, closeAll } = require('../src/platform/connection');
  const { Tenant } = await controlPlane();
  const tenant = await Tenant.findOne({ slug: SLUG }).lean();
  if (!tenant) die(`לא נמצא לקוח בשם "${SLUG}"`);

  const { conn } = await tenantConnection(tenant);
  const db = conn.db;

  const dir = path.join(OUT, `${SLUG}-${new Date().toISOString().slice(0, 10)}`);
  const manifestPath = path.join(dir, 'manifest.json');

  if (VERIFY_ONLY) {
    // Verifying is comparing what is on disk to what is in the database, right
    // now. A manifest that only records what the export thought it wrote proves
    // nothing about the export being complete.
    if (!fs.existsSync(manifestPath)) die(`אין ייצוא לבדוק ב-${dir}`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    let bad = 0;
    for (const [name, expected] of Object.entries(manifest.counts)) {
      const file = path.join(dir, `${name}.json`);
      const onDisk = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).length : -1;
      const live = await db.collection(name).countDocuments();
      const ok = onDisk === expected && onDisk === live;
      if (!ok) { bad += 1; console.log(`  ❌ ${name}: בקובץ ${onDisk}, במניפסט ${expected}, במסד ${live}`); }
    }
    console.log(bad ? `\n❌  ${bad} אוספים אינם תואמים\n` : `\n✅  הייצוא שלם — תואם למסד\n`);
    await closeAll();
    process.exit(bad ? 1 : 0);
  }

  fs.mkdirSync(dir, { recursive: true });
  console.log(`\n📦  מייצא את "${tenant.name}" → ${dir}\n`);

  const names = (await db.listCollections().toArray()).map((c) => c.name).sort();
  const counts = {};
  let total = 0;

  for (const name of names) {
    const docs = await db.collection(name).find({}).toArray();
    counts[name] = docs.length;
    total += docs.length;
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(docs, null, 1), 'utf8');
    if (docs.length) console.log(`  ✓  ${name}: ${docs.length}`);
  }

  fs.writeFileSync(manifestPath, JSON.stringify({
    tenant: { name: tenant.name, slug: tenant.slug, db_name: tenant.db_name, status: tenant.status },
    exported_at: new Date().toISOString(),
    collections: names.length,
    documents: total,
    counts,
  }, null, 2), 'utf8');

  console.log(`\n✅  ${total} מסמכים מתוך ${names.length} אוספים.`);
  console.log(`   לבדיקה שהייצוא שלם:`);
  console.log(`   node scripts/ganflow-tenant-export.js --slug ${SLUG} --out ${OUT} --verify\n`);
  console.log(`   \u{26A0}️  הקבצים מכילים ילדים אמיתיים. הם לא מוצפנים.\n`);

  await closeAll();
})().catch((e) => { console.error(e); process.exit(1); });
