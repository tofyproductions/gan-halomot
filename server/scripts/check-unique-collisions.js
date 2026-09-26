#!/usr/bin/env node
/**
 * Will the new unique indexes build on the REAL data?
 *
 * Mongo refuses to build a unique index over existing duplicates — quietly,
 * in a log line nobody reads, leaving the collection unguarded while the code
 * assumes it is guarded. So before (or right after) deploying the wave-4
 * indexes, run this against production data. It prints every collision that
 * would block each index, with ids, so the office can merge/fix the rows.
 * Read-only: aggregates only, writes nothing.
 *
 *   node scripts/check-unique-collisions.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  let total = 0;

  const report = async (label, coll, pipeline, fmt) => {
    const rows = await db.collection(coll).aggregate(pipeline).toArray();
    if (!rows.length) { console.log(`✅ ${label} — אין כפילויות`); return; }
    total += rows.length;
    console.log(`❌ ${label} — ${rows.length} התנגשויות:`);
    for (const r of rows) console.log('   ' + fmt(r));
  };

  await report('Employee.israeli_id (unique חלקי)', 'employees', [
    { $match: { israeli_id: { $type: 'string', $gt: '' } } },
    { $group: { _id: '$israeli_id', count: { $sum: 1 }, ids: { $push: '$_id' }, names: { $push: '$full_name' } } },
    { $match: { count: { $gt: 1 } } },
  ], r => `ת"ז ${r._id}: ${r.names.join(' + ')} (${r.ids.join(', ')})`);

  await report('Collection (registration_id, academic_year)', 'collections', [
    { $group: { _id: { reg: '$registration_id', year: '$academic_year' }, count: { $sum: 1 }, ids: { $push: '$_id' } } },
    { $match: { count: { $gt: 1 } } },
  ], r => `רישום ${r._id.reg} שנה ${r._id.year}: ${r.count} מסמכים (${r.ids.join(', ')})`);

  await report('Photo (classroom_id, sha256)', 'photos', [
    { $match: { sha256: { $type: 'string' } } },
    { $group: { _id: { c: '$classroom_id', s: '$sha256' }, count: { $sum: 1 }, ids: { $push: '$_id' } } },
    { $match: { count: { $gt: 1 } } },
  ], r => `כיתה ${r._id.c}: ${r.count} עותקים (${r.ids.join(', ')})`);

  await report('StockCategory (branch_id, name) פעילות', 'stockcategories', [
    { $match: { is_active: true } },
    { $group: { _id: { b: '$branch_id', n: '$name' }, count: { $sum: 1 }, ids: { $push: '$_id' } } },
    { $match: { count: { $gt: 1 } } },
  ], r => `סניף ${r._id.b} "${r._id.n}": ${r.count} קטגוריות (${r.ids.join(', ')})`);

  console.log('');
  console.log(total === 0
    ? '✅ נקי — כל האינדקסים הייחודיים ייבנו בהצלחה'
    : `⚠️ ${total} התנגשויות — יש לאחד/לתקן את השורות למעלה, אחרת האינדקסים המתאימים לא ייבנו (הקוד ימשיך לעבוד, בלי ההגנה)`);
  await mongoose.disconnect();
}

main().catch(e => { console.error(e.message); process.exit(1); });
