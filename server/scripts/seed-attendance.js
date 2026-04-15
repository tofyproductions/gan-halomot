/**
 * seed-attendance.js
 *
 * One-off seed for the TIMEDOX replacement project. Creates:
 *   - 4 Branches (one per physical location) with TIMEDOX clock config
 *   - 3 Amutot (legal entities)
 *   - ~70 Employees parsed from the salary CSV
 *
 * Usage:
 *   node scripts/seed-attendance.js \
 *     --csv "/Users/amits-mac/Downloads/Salary Table Gan HaDreams 2023 Apr 26.csv" \
 *     [--dry-run]
 *
 * Safe to re-run — upserts by business keys (name for branches/amutot,
 * full_name+branch for employees since the CSV has no Israeli IDs yet).
 *
 * IMPORTANT: This seed populates payroll *configuration* (rates, extras,
 * loans, bonuses parsed from notes). Israeli IDs are filled in later from
 * the TIMEDOX clocks or manually — unmatched Punches will resolve once
 * `israeli_id` is set on the corresponding Employee.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');

// ---------- CLI args ----------
const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = args[i + 1];
  if (!v || v.startsWith('--')) return true;
  return v;
}
const CSV_PATH = arg('csv', '/Users/amits-mac/Downloads/Salary Table Gan HaDreams 2023 Apr 26.csv');
const DRY_RUN = !!arg('dry-run', false);

// ---------- Config: canonical branch list ----------
// Names MUST match how they appear (after normalization) in the CSV col 0.
const BRANCHES = [
  { name: 'כפר סבא - משה דיין', address: '',  clock_ip: '10.0.0.3', csv_aliases: ['כפר סבא משה דיין'] },
  { name: 'כפר סבא - שאול המלך', address: '', clock_ip: '',          csv_aliases: ['כפר סבא שאול המלך'] },
  { name: 'הרצליה הרצוג',        address: '', clock_ip: '',          csv_aliases: ['הרצליה הרצוג'] },
  { name: 'תל אביב',              address: '', clock_ip: '',          csv_aliases: ['תל אביב', 'סניף תל אביב', 'ת"א', 'תא'] },
];
const AMUTOT = [
  { name: 'אמונה - כפר סבא',  short_name: 'emuna_ks'   },
  { name: 'אמונה - הרצליה',    short_name: 'emuna_hrz'  },
  { name: 'מאזן כללי',          short_name: 'maazan'     },
];

// ---------- Minimal CSV parser (handles quoted, multi-line fields) ----------
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (ch === '\r') { /* skip */ }
      else field += ch;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ---------- Helpers ----------
const HEBREW_SPACE = /\s+/g;
function norm(s) {
  return String(s || '').replace(HEBREW_SPACE, ' ').trim();
}
function parseNumber(s) {
  if (s == null) return null;
  // Extract the first numeric run from mixed text like "נטו 6,500", "ברוטו 8572".
  const m = String(s).match(/-?[\d][\d,]*(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}
// Detect whether a salary cell is marked as נטו (net) vs ברוטו (gross).
function detectNet(s) {
  const t = String(s || '');
  if (/נטו/.test(t)) return true;
  if (/ברוטו/.test(t)) return false;
  return null; // unknown — caller keeps default
}

function matchBranchName(csvName) {
  const n = norm(csvName);
  if (!n) return null;
  for (const b of BRANCHES) {
    if (norm(b.name) === n) return b.name;
    if (b.csv_aliases && b.csv_aliases.some(a => norm(a) === n)) return b.name;
  }
  return null;
}

// Parse free-text notes into loans & bonuses (best-effort; unknown stays in notes)
function extractLoans(notes) {
  const loans = [];
  // "הלוואה 50,000 תשלום 3 מתוך 10 על סך 5000" etc.
  const rx = /הלוואה\s*([\d,]+)[\s\S]*?תשלום\s*(\d+)\s*מתוך\s*(\d+)[\s\S]*?(?:על\s*סך\s*)?([\d,]+)/g;
  let m;
  while ((m = rx.exec(notes)) !== null) {
    const total = parseNumber(m[1]);
    const paid  = parseNumber(m[2]);
    const count = parseNumber(m[3]);
    const inst  = parseNumber(m[4]);
    if (total && count && inst) {
      loans.push({
        total_amount: total,
        installment_amount: inst,
        installments_total: count,
        installments_paid: paid || 0,
        notes: 'parsed from CSV notes',
      });
    }
  }
  return loans;
}
function extractBonuses(notes) {
  const bonuses = [];
  // "בונוס 10 שח * כפול מספר שעות העבודה" → per_hour
  if (/בונוס[\s\S]*?(\d+)\s*שח?[\s\S]*?(?:שעות|שעה)/i.test(notes)) {
    const m = notes.match(/בונוס[\s\S]*?(\d+)\s*שח?[\s\S]*?(?:שעות|שעה)/i);
    if (m) bonuses.push({ type: 'per_hour', amount: parseNumber(m[1]) || 0, reason: 'per-hour bonus (from notes)' });
  }
  // "בונוס 400 ש״ח הובלת קבוצה" → fixed
  const rxFixed = /בונוס\s*(\d[\d,]*)\s*ש"?[חx][^\n]*/g;
  let m;
  while ((m = rxFixed.exec(notes)) !== null) {
    const amt = parseNumber(m[1]);
    if (amt && !bonuses.find(b => b.amount === amt && b.type === 'fixed')) {
      bonuses.push({ type: 'fixed', amount: amt, reason: norm(m[0]) });
    }
  }
  return bonuses;
}

// ---------- Main ----------
async function main() {
  if (!fs.existsSync(CSV_PATH)) {
    console.error(`CSV not found: ${CSV_PATH}`);
    process.exit(1);
  }
  const text = fs.readFileSync(CSV_PATH, 'utf8');
  const rows = parseCSV(text);
  console.log(`CSV parsed: ${rows.length} raw rows`);

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');
  const { Branch, Amuta, Employee } = require('../src/models');

  // --- Branches: upsert and backfill agent_secret if missing ---
  const branchDocs = {};
  for (const b of BRANCHES) {
    let doc = await Branch.findOne({ name: b.name });
    if (!doc) {
      if (DRY_RUN) {
        console.log(`[dry] would create Branch: ${b.name}`);
        // Shadow doc so employees under this branch still parse in dry-run.
        branchDocs[b.name] = { _id: `dry:${b.name}`, name: b.name, clock_ip: b.clock_ip, agent_secret: '(dry-run)' };
        continue;
      }
      doc = await Branch.create({
        name: b.name, address: b.address, is_active: true,
        clock_ip: b.clock_ip,
        agent_secret: crypto.randomBytes(32).toString('hex'),
      });
      console.log(`+ Branch: ${b.name}  clock_ip=${b.clock_ip || '(none)'}  secret=${doc.agent_secret.slice(0,8)}…`);
    } else {
      let changed = false;
      if (b.clock_ip && !doc.clock_ip) { doc.clock_ip = b.clock_ip; changed = true; }
      if (!doc.agent_secret) { doc.agent_secret = crypto.randomBytes(32).toString('hex'); changed = true; }
      if (changed && !DRY_RUN) { await doc.save(); console.log(`~ Branch updated: ${b.name}`); }
      else console.log(`= Branch exists: ${b.name}`);
    }
    branchDocs[b.name] = doc;
  }

  // --- Amutot ---
  const amutaDocs = {};
  for (const a of AMUTOT) {
    let doc = await Amuta.findOne({ name: a.name });
    if (!doc) {
      if (DRY_RUN) {
        console.log(`[dry] would create Amuta: ${a.name}`);
        amutaDocs[a.name] = { _id: `dry:${a.name}`, name: a.name };
        continue;
      }
      doc = await Amuta.create({ name: a.name, short_name: a.short_name, is_active: true });
      console.log(`+ Amuta: ${a.name}`);
    } else {
      console.log(`= Amuta exists: ${a.name}`);
    }
    amutaDocs[a.name] = doc;
  }

  // --- Employees from CSV ---
  //
  // Header layout (after inspecting the file):
  //   Row 0:  meta title   — ignored
  //   Row 1:  amuta section headers (cols 9, 16, 23 have amuta names)
  //   Row 2:  field names  (ימי עבודה, שעות רגילות, ... per amuta)
  //   Rows 3+ data
  //
  // Column ranges per amuta block (each = 7 columns):
  //   Amuta 1 (כפר סבא):   cols  9..15   (ימי עבודה, שעות רגילות, שע"נ א', שע"נ ב', שכר שעתי, שכר גלובלי, שעות נוספות גלובלי)
  //   Amuta 2 (הרצליה):    cols 16..22
  //   Amuta 3 (מאזן):       cols 23..29
  // Common fields after cols 30..36: נסיעות, מחלה, היעדרות, חופשה, דמי חגים, gift card, הבראה
  // Then: סיבוס, מילואים, הערות
  //
  // However the first ~15 rows show that many employees use a SINGLE
  // "שכר שעתי / שכר גלובלי" column at index 6/7 which is *outside* the amuta
  // blocks — that was the old pre-split layout. We handle both: look at both
  // the legacy col 6/7 and the per-amuta rates.
  const AMUTA_NAMES_IN_ORDER = ['אמונה - כפר סבא', 'אמונה - הרצליה', 'מאזן כללי'];
  // Each amuta block is 7 cols wide, starting at col 2 (after branch+name).
  //   +0 ימי עבודה  +1 שעות רגילות  +2 שע"נ א'  +3 שע"נ ב'  +4 שכר שעתי  +5 שכר גלובלי  +6 שע"נ גלובלי
  const AMUTA_COL_START = { 'אמונה - כפר סבא': 2, 'אמונה - הרצליה': 9, 'מאזן כללי': 16 };

  const COL_BRANCH     = 0;
  const COL_NAME       = 1;
  // Common extras appear AFTER the three amuta blocks (col 23+).
  const COL_TRAVEL     = 23; // נסיעות
  const COL_SICK       = 24; // מחלה
  const COL_ABSENCE    = 25; // היעדרות
  const COL_VACATION   = 26; // חופשה
  const COL_HOLIDAYS   = 27; // דמי חגים
  const COL_GIFT       = 28; // gift card
  const COL_RECREATION = 29; // הבראה
  const COL_MEAL       = 30; // סיבוס
  const COL_RESERVE    = 31; // מילואים
  const COL_NOTES      = 32; // הערות נוספות

  let currentBranch = null;
  let created = 0, updated = 0, skipped = 0;

  // Skip header rows — the merged header occupies parser rows 0..2.
  const DATA_START_ROW = 3;

  for (let r = DATA_START_ROW; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every(c => !norm(c))) continue;

    // Forward-fill branch
    const branchCell = norm(row[COL_BRANCH]);
    if (branchCell) {
      const matched = matchBranchName(branchCell);
      if (matched) currentBranch = matched;
      else console.warn(`  ! unknown branch in CSV row ${r}: "${branchCell}"`);
    }
    if (!currentBranch) continue;

    const fullName = norm(row[COL_NAME]);
    if (!fullName) continue;
    if (/סה"?כ|סיכום|יתרה/.test(fullName)) continue; // skip totals rows

    const branchDoc = branchDocs[currentBranch];
    if (!branchDoc) { skipped++; continue; }

    // Build amuta_distribution from the three amuta blocks. Each block's
    // rate cells may carry "נטו X" / "ברוטו X" annotations — we extract both
    // the number and the net/gross flag.
    const distribution = [];
    let salaryIsNet = false;
    for (const aName of AMUTA_NAMES_IN_ORDER) {
      const start = AMUTA_COL_START[aName];
      const rawHourly = row[start + 4];
      const rawGlobal = row[start + 5];
      const rawGlobalOt = row[start + 6];
      const hourly = parseNumber(rawHourly);
      const global = parseNumber(rawGlobal);
      const globalOt = parseNumber(rawGlobalOt);
      if (hourly || global) {
        if (detectNet(rawHourly) === true || detectNet(rawGlobal) === true) salaryIsNet = true;
        const amutaDoc = amutaDocs[aName];
        if (!amutaDoc) continue;
        distribution.push({
          amuta_id: amutaDoc._id,
          hourly_rate: hourly,
          global_salary: global,
          global_ot_rate: globalOt,
          required_hours: null,
        });
      }
    }

    const hasGlobal = distribution.some(d => d.global_salary);
    const hasHourly = distribution.some(d => d.hourly_rate);
    const salaryType = hasGlobal && !hasHourly ? 'global' : 'hourly';

    const travel = parseNumber(row[COL_TRAVEL]) || 0;
    const meal   = parseNumber(row[COL_MEAL])   || 0;
    const recreation = parseNumber(row[COL_RECREATION]) || 0;
    // Notes column may contain embedded newlines — keep them, they're the
    // primary source for loans/bonuses regex extraction.
    const notes  = String(row[COL_NOTES] || '').trim();

    const loans = extractLoans(notes);
    const bonuses = extractBonuses(notes);

    const payload = {
      full_name: fullName,
      branch_id: branchDoc._id,
      salary_type: salaryType,
      salary_is_net: salaryIsNet,
      amuta_distribution: distribution,
      travel_allowance: travel,
      meal_vouchers: meal,
      recreation_annual: recreation,
      notes,
      loans,
      bonuses,
      pension_exempt:       /פטור[\s\S]*פנסיה/.test(notes),
      bituach_leumi_exempt: /פטור[\s\S]*ביטוח\s*לאומי/.test(notes),
      is_active: true,
    };

    if (DRY_RUN) {
      console.log(`[dry] + ${fullName} @ ${currentBranch}  (${salaryType}, ${distribution.length} amutot, travel=${travel}, ${loans.length} loans, ${bonuses.length} bonuses)`);
      created++;
      continue;
    }

    // Upsert on (branch_id, full_name) — until we have Israeli IDs
    const filter = { branch_id: branchDoc._id, full_name: fullName };
    const existing = await Employee.findOne(filter);

    if (existing) {
      Object.assign(existing, payload);
      await existing.save();
      updated++;
    } else {
      await Employee.create(payload);
      created++;
    }
  }

  console.log(`\n=== Employees: ${created} created, ${updated} updated, ${skipped} skipped ===`);
  console.log('\nBranch agent secrets (save these to each Pi .env file):');
  for (const name of Object.keys(branchDocs)) {
    const d = branchDocs[name];
    if (d) console.log(`  ${name.padEnd(30)}  id=${d._id}  secret=${d.agent_secret || '(unset)'}`);
  }

  await mongoose.disconnect();
  console.log('\nDone.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
