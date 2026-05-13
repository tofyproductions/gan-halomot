/**
 * Cross-match TIMEDOX clock employee exports with system Employee records.
 *
 * Produces:
 *   1. In xlsx + active system employee → already-linked (OK)
 *   2. In xlsx but NOT in system (any branch) → candidates to add
 *   3. In xlsx but system shows different branch_id → maybe cross-branch worker
 *   4. Active system employee NOT in any xlsx → archive candidate
 *
 * Doesn't write anything — printout only. Pass --report to also write JSON.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const mongoose = require('mongoose');
const { Employee, Branch } = require('../src/models');

const FILES = {
  'גן אמונה':            '/Users/amitkohta/Downloads/גן אמונה (2).xlsx',
  'הרצליה הרצוג':        '/Users/amitkohta/Downloads/הרצוג הרצליה (2).xlsx',
  'כפר סבא - משה דיין':  '/Users/amitkohta/Downloads/משה דיין כפר סבא (2).xlsx',
  'כפר סבא - קפלן':      '/Users/amitkohta/Downloads/קפלן כפר סבא (2).xlsx',
};

function pad9(v) {
  if (!v) return null;
  const digits = String(v).replace(/\D/g, '');
  if (!digits) return null;
  return digits.padStart(9, '0');
}

function readXlsx(p) {
  const wb = XLSX.read(fs.readFileSync(p), { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: false });
  const out = [];
  for (let i = 2; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const id = pad9(r[0]);
    if (!id) continue;
    out.push({
      id,
      first_name: r[1] || '',
      last_name: r[2] || '',
      home_branch_text: r[3] || '',
      emp_no: r[4] || null,
    });
  }
  return out;
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);

  const branches = await Branch.find({}).select('_id name').lean();
  const branchByName = new Map();
  for (const b of branches) {
    const nameNorm = b.name.replace(/\s+/g, ' ').trim();
    branchByName.set(nameNorm, b);
  }

  const employees = await Employee.find({}).select('_id full_name israeli_id branch_id is_active').lean();
  const empById = new Map();
  for (const e of employees) {
    if (e.israeli_id) empById.set(e.israeli_id, e);
  }
  console.log(`Total employees in DB: ${employees.length} (active: ${employees.filter(e => e.is_active).length})`);

  // Aggregate: id → { name, branches: [{name, xlsx_says_home}] }
  const xlsxIds = new Map();
  for (const [branchName, file] of Object.entries(FILES)) {
    if (!fs.existsSync(file)) { console.log(`MISSING file: ${file}`); continue; }
    const rows = readXlsx(file);
    console.log(`  ${branchName}: ${rows.length} rows`);
    for (const r of rows) {
      if (!xlsxIds.has(r.id)) xlsxIds.set(r.id, { fullName: `${r.first_name} ${r.last_name}`.trim(), inBranches: [] });
      xlsxIds.get(r.id).inBranches.push({ branch: branchName, home: r.home_branch_text });
    }
  }
  console.log(`\nUnique ת"ז in xlsx files: ${xlsxIds.size}\n`);

  // Bucket 1: in xlsx + active system → OK
  // Bucket 2: in xlsx + inactive system → maybe re-activate
  // Bucket 3: in xlsx but no system record → add
  // Bucket 4: active system not in any xlsx → archive candidate

  const buckets = { ok: [], inactive: [], missingFromSystem: [], notInClocks: [] };

  for (const [id, info] of xlsxIds) {
    const emp = empById.get(id);
    if (!emp) {
      buckets.missingFromSystem.push({ id, name: info.fullName, branches: info.inBranches });
    } else if (!emp.is_active) {
      buckets.inactive.push({ id, name: info.fullName, db_name: emp.full_name, branches: info.inBranches });
    } else {
      buckets.ok.push({ id, name: info.fullName, db_name: emp.full_name });
    }
  }
  for (const e of employees) {
    if (!e.is_active) continue;
    if (!e.israeli_id) continue;
    if (!xlsxIds.has(e.israeli_id)) {
      buckets.notInClocks.push({ id: e.israeli_id, name: e.full_name });
    }
  }

  console.log(`=== Bucket 1: Active system employees registered on a clock (${buckets.ok.length}) ===`);
  for (const r of buckets.ok.slice(0, 5)) console.log(`  ${r.id} ${r.db_name}`);
  if (buckets.ok.length > 5) console.log(`  ... +${buckets.ok.length - 5} more`);

  console.log(`\n=== Bucket 2: Inactive in system but still on the clock (${buckets.inactive.length}) ===`);
  for (const r of buckets.inactive) console.log(`  ${r.id} ${r.db_name}  →  IN BRANCHES: ${r.branches.map(b => b.branch).join(', ')}`);

  console.log(`\n=== Bucket 3: On the clock but MISSING from system (${buckets.missingFromSystem.length}) ===`);
  for (const r of buckets.missingFromSystem) console.log(`  ${r.id} ${r.name}  →  ON CLOCKS: ${r.branches.map(b => b.branch).join(', ')}`);

  console.log(`\n=== Bucket 4: Active in system but NOT on any clock — archive candidates (${buckets.notInClocks.length}) ===`);
  for (const r of buckets.notInClocks) console.log(`  ${r.id} ${r.name}`);

  if (process.argv.includes('--report')) {
    fs.writeFileSync(
      path.join(__dirname, 'timedox-cross-match-report.json'),
      JSON.stringify(buckets, null, 2),
    );
    console.log('\nReport saved to timedox-cross-match-report.json');
  }

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
