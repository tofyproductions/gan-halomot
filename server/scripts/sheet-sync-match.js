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
 *   node scripts/sheet-sync-match.js --sheet <id> --branch "<שם סניף>"
 *   node scripts/sheet-sync-match.js --sheet <id> --branch "<שם סניף>" --write
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { Child, Branch, Classroom } = require('../src/models');
const { readGrids } = require('../src/services/sheet-sync/sheets-client');
const { parseChildRows } = require('./lib/nursery-history');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
}

/** Names compared only to REPORT a likely pair, never to establish one. */
function normalizeName(s) {
  return String(s || '').replace(/["'׳״]/g, '').replace(/\s+/g, ' ').trim();
}

async function matchReport({ sheetId, branchName }) {
  const branch = await Branch.findOne({ name: branchName }).lean();
  if (!branch) throw new Error(`no branch named ${branchName}`);

  const rooms = await Classroom.find({ branch_id: branch._id, category: 'תינוקייה', is_active: true }).lean();
  const roomIds = rooms.map(r => r._id);
  const children = await Child.find({ classroom_id: { $in: roomIds } })
    .select('_id full_name sheet_access_id birth_date').lean();

  const { children: grid } = await readGrids(sheetId);
  const sheetChildren = parseChildRows(grid);

  const byName = new Map();
  for (const c of children) {
    const k = normalizeName(c.full_name);
    byName.set(k, (byName.get(k) || []).concat(c));
  }

  const matched = [];
  const unmatched = [];
  const ambiguous = [];

  for (const s of sheetChildren) {
    if (!s.access_id) { unmatched.push({ ...s, why: 'no AccessID in the sheet' }); continue; }
    const already = children.find(c => c.sheet_access_id === s.access_id);
    if (already) {
      matched.push({ access_id: s.access_id, sheet_name: s.name, child_id: String(already._id), child_name: already.full_name, by: 'already linked' });
      continue;
    }
    const candidates = byName.get(normalizeName(s.name)) || [];
    if (candidates.length === 1) {
      matched.push({ access_id: s.access_id, sheet_name: s.name, child_id: String(candidates[0]._id), child_name: candidates[0].full_name, by: 'name + branch' });
    } else if (candidates.length > 1) {
      ambiguous.push({ ...s, candidates: candidates.map(c => ({ id: String(c._id), name: c.full_name, birth_date: c.birth_date })) });
    } else {
      unmatched.push({ ...s, why: 'no child of that name in this branch' });
    }
  }
  return { branch: branch.name, matched, unmatched, ambiguous };
}

async function main() {
  const sheetId = arg('--sheet');
  const branchName = arg('--branch');
  const write = process.argv.includes('--write');
  if (!sheetId || !branchName) {
    console.error('usage: node scripts/sheet-sync-match.js --sheet <id> --branch "<name>" [--write]');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI);
  const report = await matchReport({ sheetId, branchName });

  console.log(`\nסניף: ${report.branch}`);
  console.log(`\nמותאמים (${report.matched.length}):`);
  report.matched.forEach(m => console.log(`  ${m.sheet_name}  →  ${m.child_name}  [${m.by}]`));
  console.log(`\nלא נמצאו (${report.unmatched.length}):`);
  report.unmatched.forEach(u => console.log(`  ${u.name}  —  ${u.why}`));
  console.log(`\nדו-משמעיים (${report.ambiguous.length}):`);
  report.ambiguous.forEach(a => console.log(`  ${a.name}  →  ${a.candidates.map(c => c.name + ' (' + c.birth_date + ')').join(' | ')}`));

  if (!write) {
    console.log('\nהרצה יבשה. שום דבר לא נכתב. להוסיף --write אחרי קריאת הרשימה.\n');
  } else {
    let n = 0;
    for (const m of report.matched) {
      if (m.by === 'already linked') continue;
      await Child.updateOne({ _id: m.child_id }, { $set: { sheet_access_id: m.access_id } });
      n += 1;
    }
    console.log(`\nנכתבו ${n} שיוכים.\n`);
  }
  await mongoose.disconnect();
}

module.exports = { matchReport, normalizeName };
if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
