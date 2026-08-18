#!/usr/bin/env node
/**
 * Copy the live database into a separate demo database.
 *
 * Reads from MONGODB_URI and never writes to it. The copy is a plain
 * collection-by-collection read and insert rather than mongodump, so it needs
 * no MongoDB command-line tools installed — it runs from either machine with
 * nothing but this repo.
 *
 * The copy is still FULL OF REAL CHILDREN until the scrambler has run over it.
 * Clone and scramble are one operation in two commands; never stop between them.
 *
 * Usage:
 *   node scripts/ganflow-demo-clone.js --to "mongodb+srv://.../ganflow_demo"
 *   node scripts/ganflow-demo-clone.js --to "..." --wipe    # empty the target first
 */

const mongoose = require('mongoose');
require('dotenv').config();

const argv = process.argv.slice(2);
const TO = argv.includes('--to') ? argv[argv.indexOf('--to') + 1] : null;
const WIPE = argv.includes('--wipe');
const FROM = process.env.MONGODB_URI;

function die(m) { console.error(`\n❌  ${m}\n`); process.exit(1); }

if (!FROM) die('חסר MONGODB_URI בסביבה (קובץ .env של השרת).');
if (!TO) die('חסר --to. צריך כתובת של מסד ההדגמה.');
if (TO.trim() === FROM.trim()) die('היעד זהה למקור. זה המסד האמיתי.');

const targetDb = (TO.match(/\/([^/?]+)(\?|$)/) || [])[1];
if (!targetDb) die('לא הצלחתי לקרוא שם מסד מכתובת היעד.');
if (!/demo/i.test(targetDb)) die(`שם מסד היעד הוא "${targetDb}" ואינו מכיל "demo". מסרב.`);

(async function main() {
  const src = await mongoose.createConnection(FROM).asPromise();
  const dst = await mongoose.createConnection(TO).asPromise();

  console.log(`\n\u{1F4E6} מעתיק ${src.db.databaseName}  →  ${dst.db.databaseName}\n`);

  const names = (await src.db.listCollections().toArray()).map((c) => c.name).sort();
  let total = 0;

  for (const name of names) {
    const source = src.db.collection(name);
    const target = dst.db.collection(name);
    const count = await source.countDocuments();
    if (WIPE) await target.deleteMany({});
    if (!count) { console.log(`  ·  ${name}: ריק`); continue; }

    let copied = 0;
    let batch = [];
    const cursor = source.find({});
    for await (const doc of cursor) {
      batch.push(doc);
      if (batch.length === 500) { await target.insertMany(batch, { ordered: false }).catch(() => {}); copied += batch.length; batch = []; }
    }
    if (batch.length) { await target.insertMany(batch, { ordered: false }).catch(() => {}); copied += batch.length; }

    total += copied;
    console.log(`  ✓  ${name}: ${copied}`);
  }

  console.log(`\n─── ${total} מסמכים הועתקו ───`);
  console.log('\n⚠️  המסד הזה מכיל כרגע נתונים אמיתיים. הרץ עכשיו:');
  console.log(`   node scripts/ganflow-demo-scramble.js --uri "${TO}" --unknown\n`);

  await src.close();
  await dst.close();
})().catch((e) => { console.error(e); process.exit(1); });
