/**
 * One-shot: every ת"ז that appears on at least one TIMEDOX clock but has no
 * Employee record in the system is added as an ARCHIVED (is_active=false)
 * employee, keyed to the first branch where the clock listed them.
 *
 * Re-running is safe — already-imported ones (israeli_id match) are skipped.
 *
 * Run:   node scripts/import-archived-from-timedox.js [--apply]
 */
require('dotenv').config();
const fs = require('fs');
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
    const first = (r[1] || '').toString().trim();
    const last = (r[2] || '').toString().trim();
    out.push({ id, full_name: `${first} ${last}`.replace(/\s+/g, ' ').trim() });
  }
  return out;
}

async function main() {
  const apply = process.argv.includes('--apply');
  console.log(`Mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);
  await mongoose.connect(process.env.MONGODB_URI);

  const branches = await Branch.find({}).select('_id name').lean();
  const branchByName = new Map();
  for (const b of branches) {
    branchByName.set(b.name.replace(/\s+/g, ' ').trim(), b._id);
  }

  // Build "id → { name, first_branch_id }" from xlsx (first branch wins).
  const xlsxIds = new Map();
  for (const [branchName, file] of Object.entries(FILES)) {
    const branchId = branchByName.get(branchName);
    if (!branchId) { console.log(`UNKNOWN branch in DB: ${branchName}`); continue; }
    if (!fs.existsSync(file)) { console.log(`MISSING file: ${file}`); continue; }
    for (const r of readXlsx(file)) {
      if (!xlsxIds.has(r.id)) xlsxIds.set(r.id, { name: r.full_name, branch_id: branchId });
    }
  }

  const existing = await Employee.find({ israeli_id: { $in: [...xlsxIds.keys()] } }).select('israeli_id').lean();
  const existingIds = new Set(existing.map(e => e.israeli_id));

  let added = 0;
  for (const [id, info] of xlsxIds) {
    if (existingIds.has(id)) continue;
    console.log(`  + ${id} ${info.name} → archived (${[...branchByName.entries()].find(([n, b]) => String(b) === String(info.branch_id))?.[0] || info.branch_id})`);
    if (apply) {
      await Employee.create({
        full_name: info.name || '(שם חסר)',
        israeli_id: id,
        branch_id: info.branch_id,
        is_active: false,
        notes: 'ייובא אוטומטית מקובץ עובדי שעון TIMEDOX',
      });
    }
    added++;
  }
  console.log(`\n${apply ? 'Added' : 'Would add'} ${added} archived employees.`);
  if (!apply) console.log('Re-run with --apply.');
  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
