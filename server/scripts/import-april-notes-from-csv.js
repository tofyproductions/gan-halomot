/**
 * One-shot: read /Users/amitkohta/Downloads/טבלת שכר ... אפריל 26.csv
 * and copy "הערות נוספות" (last column) into PayrollMonth.manual.notes
 * for month 2026-05, keyed by employee full_name.
 *
 * Idempotent: skips rows where May already has a non-empty note.
 *
 * Usage: node scripts/import-april-notes-from-csv.js [csv-path]
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const mongoose = require('mongoose');
const { PayrollMonth, Employee } = require('../src/models');

const DST_MONTH = '2026-05';
const DEFAULT_CSV = '/Users/amitkohta/Downloads/טבלת שכר - גן החלומות -תשפ״ו.xlsx_ - אפריל 26.csv';

function normalizeName(s) {
  if (!s) return '';
  return String(s)
    .replace(/[()‘’“”"'.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/ך/g, 'כ').replace(/ם/g, 'מ').replace(/ן/g, 'נ')
    .replace(/ף/g, 'פ').replace(/ץ/g, 'צ');
}

async function main() {
  const csvPath = process.argv[2] || DEFAULT_CSV;
  if (!fs.existsSync(csvPath)) throw new Error(`CSV not found: ${csvPath}`);
  const raw = fs.readFileSync(csvPath, 'utf8');

  const records = parse(raw, {
    relax_column_count: true,
    skip_empty_lines: false,
    trim: false,
  });
  console.log(`Parsed ${records.length} CSV rows`);

  await mongoose.connect(process.env.MONGODB_URI);

  const employees = await Employee.find({ is_active: true })
    .select('_id full_name branch_id').lean();
  console.log(`Loaded ${employees.length} active employees`);

  const empByNorm = new Map();
  for (const e of employees) empByNorm.set(normalizeName(e.full_name), e);

  // Column indexes (0-based) — from inspected header structure
  const NAME_COL = 1;
  const NOTES_COL = 33; // last column "הערות נוספות"

  let attempted = 0;
  let migrated = 0;
  let skipped = 0;
  let noMatch = 0;
  let noNote = 0;

  // Data rows start after the 4-line header block
  for (let i = 4; i < records.length; i++) {
    const row = records[i];
    if (!row) continue;
    const rawName = row[NAME_COL];
    const rawNote = row[NOTES_COL];
    if (!rawName || !rawName.trim()) continue;
    const name = rawName.trim();
    const note = (rawNote || '').trim();
    if (!note) { noNote++; continue; }
    attempted++;

    // Exact normalized match first
    let emp = empByNorm.get(normalizeName(name));
    if (!emp) {
      // Fuzzy: ≥ 2 token overlap (or 1-token exact)
      const target = normalizeName(name).split(' ').filter(Boolean);
      let best = null, bestCommon = 0;
      for (const cand of employees) {
        const candTokens = normalizeName(cand.full_name).split(' ').filter(Boolean);
        let common = 0;
        for (const t of target) if (candTokens.includes(t)) common++;
        const required = target.length === 1 ? 1 : 2;
        if (common >= required && common > bestCommon) {
          best = cand; bestCommon = common;
        }
      }
      emp = best;
    }
    if (!emp) {
      console.log(`  NO MATCH: "${name}" — note="${note.slice(0, 40)}…"`);
      noMatch++;
      continue;
    }

    const existing = await PayrollMonth.findOne({ employee_id: emp._id, month: DST_MONTH }).lean();
    if (existing?.manual?.notes && existing.manual.notes.trim()) {
      console.log(`  skip ${emp.full_name} (already has May note)`);
      skipped++;
      continue;
    }
    await PayrollMonth.findOneAndUpdate(
      { employee_id: emp._id, month: DST_MONTH },
      {
        $set: { 'manual.notes': note },
        $setOnInsert: { branch_id: emp.branch_id, employee_id: emp._id, month: DST_MONTH },
      },
      { upsert: true },
    );
    migrated++;
    console.log(`  ✓ ${emp.full_name}`);
  }

  console.log('\n— summary —');
  console.log(`attempted=${attempted} migrated=${migrated} skipped=${skipped} noMatch=${noMatch} emptyNote=${noNote}`);

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
