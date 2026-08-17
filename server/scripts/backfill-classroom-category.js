/**
 * Give every classroom the age group it has always had in its name.
 *
 * A room is matched to the children waiting for it through `category` and
 * nothing else: the placement screen maps תינוק→תינוקייה, פעוט→צעירים,
 * בוגר→בוגרים and lists the rooms of each. `category` was optional and almost
 * nothing set it, so almost every room in the network belonged to no group and
 * could receive no child — while the branches screen showed it sitting there,
 * active, with a capacity. The placement screen said "אין כיתות לשנה זו" and
 * was, on its own terms, telling the truth.
 *
 * The name is a reliable source here and only here: these rooms are named
 * תינוקייה א, צעירים, בוגרים — the group IS the name, because the gan names
 * rooms after the group. That will not hold for a room called "כיתת הפרפרים",
 * which is why this is a one-off backfill and not a fallback in the matching
 * code. From here the field is required at every creation path.
 *
 * Rooms whose names carry U+FFFD are left alone. They are the sync's corrupted
 * duplicates, not rooms, and they are to be deleted rather than repaired.
 *
 *   node scripts/backfill-classroom-category.js          # report only
 *   node scripts/backfill-classroom-category.js --write  # apply
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { Classroom, Branch } = require('../src/models');

const WRITE = process.argv.includes('--write');

/** The group a room's name names, or null when the name does not say. */
function categoryFromName(name) {
  const n = String(name || '');
  if (/�/.test(n)) return null;          // corrupted row, not a room
  if (/תינוק/.test(n)) return 'תינוקייה';
  if (/צעיר/.test(n)) return 'צעירים';
  if (/בוגר/.test(n)) return 'בוגרים';
  return null;
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);

  const branches = await Branch.find({}).select('name').lean();
  const branchName = new Map(branches.map(b => [String(b._id), b.name]));

  const rooms = await Classroom.find({
    $or: [{ category: null }, { category: { $exists: false } }],
  }).lean();

  const resolved = [];
  const unresolved = [];
  for (const room of rooms) {
    const category = categoryFromName(room.name);
    (category ? resolved : unresolved).push({ ...room, category });
  }

  const label = r => `${branchName.get(String(r.branch_id)) || '—'} · ${r.academic_year} · "${r.name}"`
    + `${r.is_active ? '' : ' (לא פעילה)'}`;

  console.log(`כיתות ללא קבוצת גיל: ${rooms.length}\n`);

  console.log(`ניתן להסיק מהשם — ${resolved.length}:`);
  for (const r of resolved) console.log(`  ${label(r)}  →  ${r.category}`);

  if (unresolved.length) {
    console.log(`\nלא ניתן להסיק — ${unresolved.length} (יש להגדיר ידנית במסך הסניפים,`
      + ` או למחוק אם השם פגום):`);
    for (const r of unresolved) console.log(`  ${label(r)}`);
  }

  if (!WRITE) {
    console.log('\nדוח בלבד. להחלה: node scripts/backfill-classroom-category.js --write');
    await mongoose.disconnect();
    return;
  }

  let written = 0;
  for (const r of resolved) {
    await Classroom.updateOne({ _id: r._id }, { $set: { category: r.category } });
    written++;
  }
  console.log(`\nעודכנו ${written} כיתות.`);

  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
