/**
 * Which child in the sheet is which child in the database.
 *
 * Run once per branch, read by a person, and only then allowed to write. The
 * sync never resolves an identity at runtime: by the time a pass runs, every
 * child it touches already carries `sheet_access_id`, or it is skipped.
 *
 * Dry by default. Same reasoning as import-nursery-history.js: a mistyped
 * MONGODB_URI should produce a printout, not an incident.
 *
 * Four things are reported and NONE of them are auto-resolved, because each
 * one is a decision only a person should make:
 *   - `relinked`   — the sole name-candidate already carries a DIFFERENT
 *                    sheet_access_id. Overwriting it silently would erase
 *                    whatever the previous link meant; a person confirms it.
 *   - `duplicates` — two rows in the SHEET share one AccessID. The identity
 *                    is ambiguous at the source, so neither row is matched.
 *   - `collisions` — two different sheet rows would both point at the SAME
 *                    never-linked child (typically two rows sharing a name).
 *                    Writing either first would make the other one wrong.
 * Only `matched` entries whose `by` is not "כבר משויך" are ever written, and
 * `relinked`/`duplicates`/`collisions` never contribute to `matched` at all
 * — see the loop bodies below for exactly where each is turned away.
 *
 *   node scripts/sheet-sync-match.js --sheet <id> --branch "<שם סניף>"
 *   node scripts/sheet-sync-match.js --sheet <id> --branch "<שם סניף>" --write
 *   node scripts/sheet-sync-match.js --sheet <id> --branch "<שם סניף>" --year "2026/2027"
 *
 * `--year` narrows the classroom query directly, for an operator who wants to
 * be explicit. Left out, the newest year per room is picked the same way the
 * live board does — see `dedupeNewest` below, and why: this database is
 * verified to carry stale, still-`is_active` rooms from the prior year, and
 * without this a rollover pulls departed children into the matching pool.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { Child, Branch, Classroom } = require('../src/models');
const { dedupeNewest } = require('../src/services/classroomList');
const { normalizeChildName } = require('../src/services/academic-year.service');
const { readGrids } = require('../src/services/sheet-sync/sheets-client');
const { parseChildRows } = require('./lib/nursery-history');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
}

async function matchReport({ sheetId, branchName, year }) {
  const branch = await Branch.findOne({ name: branchName }).lean();
  if (!branch) throw new Error(`no branch named ${branchName}`);

  // Which rooms are "this branch's תינוקייה, now" — see the header comment
  // for why the newest-year rule matters. An explicit --year bypasses it and
  // asks for exactly that year instead.
  const roomQuery = { branch_id: branch._id, category: 'תינוקייה', is_active: true };
  if (year) roomQuery.academic_year = year;
  const rawRooms = await Classroom.find(roomQuery).lean();
  const rooms = year ? rawRooms : dedupeNewest(rawRooms);
  const years = [...new Set(rooms.map(r => r.academic_year))].filter(Boolean).sort();
  const roomIds = rooms.map(r => r._id);

  const children = await Child.find({ classroom_id: { $in: roomIds } })
    .select('_id child_name sheet_access_id birth_date').lean();

  const { children: grid } = await readGrids(sheetId);
  const sheetChildren = parseChildRows(grid);

  // Two sheet rows sharing one AccessID make that identity ambiguous at the
  // SOURCE — neither row is trustworthy, so neither is matched at all.
  const accessIdCounts = new Map();
  for (const s of sheetChildren) {
    if (!s.access_id) continue;
    accessIdCounts.set(s.access_id, (accessIdCounts.get(s.access_id) || 0) + 1);
  }
  const duplicateSet = new Set([...accessIdCounts.entries()].filter(([, n]) => n > 1).map(([id]) => id));
  const duplicates = sheetChildren.filter(s => duplicateSet.has(s.access_id));

  const byName = new Map();
  for (const c of children) {
    const k = normalizeChildName(c.child_name);
    byName.set(k, (byName.get(k) || []).concat(c));
  }

  const matched = [];
  const unmatched = [];
  const ambiguous = [];
  const relinked = [];
  // childId -> proposed name-matches, collected before committing to `matched`
  // so two rows proposing the SAME never-linked child can be caught first.
  const proposedByChild = new Map();

  for (const s of sheetChildren) {
    if (duplicateSet.has(s.access_id)) continue; // reported under `duplicates`, matched with nothing

    if (!s.access_id) { unmatched.push({ ...s, why: 'לשורה הזו אין AccessID בגיליון' }); continue; }

    const already = children.find(c => c.sheet_access_id === s.access_id);
    if (already) {
      matched.push({ access_id: s.access_id, sheet_name: s.name, child_id: String(already._id), child_name: already.child_name, by: 'כבר משויך' });
      continue;
    }

    const candidates = byName.get(normalizeChildName(s.name)) || [];
    if (candidates.length === 1) {
      const child = candidates[0];
      if (child.sheet_access_id) {
        // The sole name-candidate is already linked to a DIFFERENT AccessID.
        // Re-linking a child is a decision, not a default — never written.
        relinked.push({
          access_id: s.access_id, sheet_name: s.name, child_id: String(child._id),
          child_name: child.child_name, old_access_id: child.sheet_access_id,
        });
      } else {
        const list = proposedByChild.get(String(child._id)) || [];
        list.push({ sheetRow: s, child });
        proposedByChild.set(String(child._id), list);
      }
    } else if (candidates.length > 1) {
      ambiguous.push({ ...s, candidates: candidates.map(c => ({ id: String(c._id), name: c.child_name, birth_date: c.birth_date })) });
    } else {
      unmatched.push({ ...s, why: 'אין ילד בשם הזה בסניף' });
    }
  }

  const collisions = [];
  for (const [childId, list] of proposedByChild) {
    if (list.length > 1) {
      // Two different sheet rows both propose linking the same never-linked
      // child. Writing either first would silently make the other one wrong.
      collisions.push({
        child_id: childId,
        child_name: list[0].child.child_name,
        rows: list.map(p => ({ access_id: p.sheetRow.access_id, sheet_name: p.sheetRow.name })),
      });
    } else {
      const p = list[0];
      matched.push({ access_id: p.sheetRow.access_id, sheet_name: p.sheetRow.name, child_id: String(p.child._id), child_name: p.child.child_name, by: 'שם + סניף' });
    }
  }

  return { branch: branch.name, years, matched, unmatched, ambiguous, relinked, duplicates, collisions };
}

async function main() {
  const sheetId = arg('--sheet');
  const branchName = arg('--branch');
  const year = arg('--year');
  const write = process.argv.includes('--write');
  if (!sheetId || !branchName) {
    console.error('usage: node scripts/sheet-sync-match.js --sheet <id> --branch "<name>" [--year "<YYYY/YYYY>"] [--write]');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI);
  const report = await matchReport({ sheetId, branchName, year });

  console.log(`\nשנה: ${report.years.join(', ') || 'לא נמצאו חדרי תינוקייה פעילים'}`);
  console.log(`\nסניף: ${report.branch}`);
  console.log(`\nמותאמים (${report.matched.length}):`);
  report.matched.forEach(m => console.log(`  ${m.sheet_name}  →  ${m.child_name}  [${m.by}]`));
  console.log(`\nלא נמצאו (${report.unmatched.length}):`);
  report.unmatched.forEach(u => console.log(`  ${u.name}  —  ${u.why}`));
  console.log(`\nדו-משמעיים (${report.ambiguous.length}):`);
  report.ambiguous.forEach(a => console.log(`  ${a.name}  →  ${a.candidates.map(c => c.name + ' (' + c.birth_date + ')').join(' | ')}`));
  console.log(`\nהחלפת שיוך קיים — לא ייכתב אוטומטית (${report.relinked.length}):`);
  report.relinked.forEach(r => console.log(`  ${r.sheet_name}  →  ${r.child_name}   שיוך קיים: ${r.old_access_id}   מוצע: ${r.access_id}`));
  console.log(`\nAccessID כפול בגיליון — לא ישויך (${report.duplicates.length}):`);
  report.duplicates.forEach(d => console.log(`  ${d.name}  (AccessID ${d.access_id})`));
  console.log(`\nהתנגשות יעד — כמה שורות מתאימות לאותו ילד — לא ישויך (${report.collisions.length}):`);
  report.collisions.forEach(c => console.log(`  ${c.child_name}  ←  ${c.rows.map(r => r.sheet_name + ' (' + r.access_id + ')').join(' | ')}`));

  if (!write) {
    console.log('\nהרצה יבשה. שום דבר לא נכתב. להוסיף --write אחרי קריאת הרשימה.\n');
  } else {
    let n = 0;
    for (const m of report.matched) {
      if (m.by === 'כבר משויך') continue;
      await Child.updateOne({ _id: m.child_id }, { $set: { sheet_access_id: m.access_id } });
      n += 1;
    }
    console.log(`\nנכתבו ${n} שיוכים.\n`);
  }
  await mongoose.disconnect();
}

module.exports = { matchReport };
if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
