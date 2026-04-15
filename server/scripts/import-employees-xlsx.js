/**
 * One-off: import employee data from the 4 xlsx files under ~/Downloads
 * into the Employee collection.
 *
 * For each xlsx row we try to find an existing Employee in the same branch
 * (or across all branches as a fallback) by a normalized name comparison.
 * When a match is found we UPDATE israeli_id (and position/branch if empty).
 * When no match is found we CREATE a new Employee in the branch that the
 * xlsx file is mapped to.
 *
 * Branch mapping (by xlsx file name):
 *   משה דיין כפר סבא → כפר סבא - משה דיין
 *   הרצוג הרצליה     → הרצליה הרצוג
 *   קפלן כפר סבא     → כפר סבא - קפלן    (legacy branch, currently empty)
 *   גן אמונה          → תל אביב            (same people as the "תל אביב" seed)
 *
 * Run:
 *   node scripts/import-employees-xlsx.js [--dry-run]
 */
require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');

const DRY_RUN = process.argv.includes('--dry-run');

// The parser runs externally via python (openpyxl); we read its JSON output.
// See /tmp/all-employees-xlsx.json produced by `python3 parse-xlsx.py`.
const XLSX_JSON = '/tmp/all-employees-xlsx.json';

const FILE_TO_BRANCH = {
  'משה דיין כפר סבא': 'כפר סבא - משה דיין',
  'הרצוג הרצליה':      'הרצליה הרצוג',
  'קפלן כפר סבא':      'כפר סבא - קפלן',
  'גן אמונה':           'תל אביב',
};

// --- Name normalization helpers ------------------------------------------
//
// Hebrew names vary a lot between sources: first/last order, optional
// parentheticals, double spaces, ה vs א swaps from transcription, etc.
// We build a "name key" that's stable across these variations:
//   1. Strip parentheses
//   2. Keep only Hebrew letters + digits + space
//   3. Split on whitespace, SORT the tokens, join with single space
// This way "אורלי מור" and "מור אורלי" produce the same key.
function nameKey(name) {
  // Replace parens with spaces so their content becomes extra tokens
  // (nicknames like "(בטי)", "(קטי)" help match when the formal first name
  // is unfamiliar or transliterated).
  return String(name || '')
    .replace(/[()]/g, ' ')
    .replace(/[^\u0590-\u05FF0-9\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

/** Score overlap by shared tokens (for fuzzy fallback). */
function tokenOverlap(a, b) {
  const ta = new Set(a.split(' ').filter(Boolean));
  const tb = new Set(b.split(' ').filter(Boolean));
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared;
}

/** Standard Levenshtein distance between two strings. */
function leven(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  const m = a.length, n = b.length;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(
        dp[j] + 1,            // deletion
        dp[j - 1] + 1,        // insertion
        prev + (a[i - 1] === b[j - 1] ? 0 : 1) // substitution
      );
      prev = tmp;
    }
  }
  return dp[n];
}

/**
 * True if the xlsx name and the DB name are "the same person after typos".
 * Policy: at least one exact-token match (a strong anchor), and for every
 * remaining token in the xlsx key there exists a DB token with Levenshtein
 * distance <= 2. This catches spelling variants like "ציפורה קופטיאב" vs
 * "ציפורה קופטאיב" without matching unrelated people who share a single
 * common last name.
 */
function fuzzyTokenMatch(keyXlsx, keyDb) {
  const tx = keyXlsx.split(' ').filter(Boolean);
  const td = keyDb.split(' ').filter(Boolean);
  if (tx.length === 0 || td.length === 0) return false;

  // Path A: every DB token finds an xlsx counterpart (exact OR Leven ≤ 2).
  // Anchor = at least one EXACT match. This handles the "extra xlsx tokens"
  // case (e.g. xlsx "בטי בירייטאל טסרה" vs db "ברטה טסרה" — DB tokens
  // are covered and טסרה is exact).
  const usedXA = new Set();
  let anchorA = false;
  let pathA = true;
  for (const d of td) {
    let matched = null;
    // Prefer exact
    for (const x of tx) {
      if (usedXA.has(x)) continue;
      if (x === d) { matched = x; anchorA = true; break; }
    }
    if (!matched) {
      for (const x of tx) {
        if (usedXA.has(x)) continue;
        const maxEdits = Math.min(x.length, d.length) <= 3 ? 1 : 2;
        if (leven(x, d) <= maxEdits) { matched = x; break; }
      }
    }
    if (!matched) { pathA = false; break; }
    usedXA.add(matched);
  }
  if (pathA && anchorA) return true;

  // Path B: full-string Levenshtein ≤ 2 on the joined key. Catches typos
  // where NO token matches exactly but all are close (e.g. "ענת רוה" vs
  // "עינת רווה").
  if (Math.abs(keyXlsx.length - keyDb.length) <= 3 && leven(keyXlsx, keyDb) <= 2) {
    return true;
  }

  return false;
}

(async () => {
  if (!fs.existsSync(XLSX_JSON)) {
    console.error(`Missing ${XLSX_JSON}. Run the python parser first.`);
    process.exit(1);
  }
  const xlsxData = JSON.parse(fs.readFileSync(XLSX_JSON, 'utf8'));

  await mongoose.connect(process.env.MONGODB_URI);
  const { Branch, Employee, Punch } = require('../src/models');

  // Preload branches
  const branchByName = {};
  for (const fileKey of Object.keys(FILE_TO_BRANCH)) {
    const target = FILE_TO_BRANCH[fileKey];
    const doc = await Branch.findOne({ name: target });
    if (!doc) { console.warn(`  ! Branch not found in DB: ${target}`); continue; }
    branchByName[fileKey] = doc;
  }

  // Preload all existing employees indexed by nameKey + branch
  const allEmployees = await Employee.find({ is_active: true }).lean();
  console.log(`Existing active employees in DB: ${allEmployees.length}`);

  // Index: nameKey → [employee, ...]  (across all branches, so we can find
  // someone who is currently in the "wrong" branch per the xlsx)
  const byKey = new Map();
  for (const e of allEmployees) {
    const k = nameKey(e.full_name);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(e);
  }

  const summary = {
    matched_updated: 0,
    matched_skipped: 0,
    fuzzy_matched: 0,
    created: 0,
    branch_missing: 0,
    ambiguous: [],
  };

  for (const [fileKey, rows] of Object.entries(xlsxData)) {
    const branchDoc = branchByName[fileKey];
    console.log(`\n=== ${fileKey} → ${branchDoc?.name || '(branch missing)'} (${rows.length} rows) ===`);
    if (!branchDoc) { summary.branch_missing += rows.length; continue; }

    for (const xRow of rows) {
      const israeliId = (xRow.israeli_id || '').padStart(9, '0');
      // Skip test/system rows (e.g. "999999999  גן החלומות - פרו")
      if (/^9{9}$/.test(israeliId) || /^0{9}$/.test(israeliId) || !xRow.full_name) continue;

      const key = nameKey(xRow.full_name);
      let candidates = byKey.get(key) || [];

      // Fuzzy fallback 1: 2+ shared exact tokens (catches swaps/reorder)
      let fuzzy = false;
      if (candidates.length === 0) {
        const fuzzyHits = [];
        for (const [k, emps] of byKey.entries()) {
          if (tokenOverlap(k, key) >= 2) fuzzyHits.push(...emps);
        }
        if (fuzzyHits.length > 0) {
          candidates = fuzzyHits;
          fuzzy = true;
        }
      }
      // Fuzzy fallback 2: 1 exact token + remaining tokens within Leven ≤ 2
      // (catches typos like ציפורה קופטיאב ↔ ציפורה קופטאיב)
      if (candidates.length === 0) {
        const typoHits = [];
        for (const [k, emps] of byKey.entries()) {
          if (fuzzyTokenMatch(key, k)) typoHits.push(...emps);
        }
        if (typoHits.length > 0) {
          candidates = typoHits;
          fuzzy = true;
        }
      }

      if (candidates.length === 0) {
        // No match — create new Employee
        if (DRY_RUN) {
          console.log(`  + CREATE ${xRow.full_name} [${israeliId}] in ${branchDoc.name}`);
        } else {
          const emp = await Employee.create({
            full_name: xRow.full_name,
            israeli_id: israeliId,
            branch_id: branchDoc._id,
            position: xRow.position || '',
            salary_type: 'hourly',
            is_active: true,
          });
          console.log(`  + CREATED ${emp.full_name} [${emp.israeli_id}]`);
        }
        summary.created++;
        continue;
      }

      if (candidates.length > 1) {
        summary.ambiguous.push({
          xlsx: xRow.full_name,
          candidates: candidates.map(c => `${c.full_name} (${c.branch_id})`),
        });
        console.log(`  ? AMBIGUOUS "${xRow.full_name}" matched ${candidates.length} employees — skipping`);
        continue;
      }

      const target = candidates[0];
      // Re-fetch as a full Mongoose doc so post-save hooks fire (auto-relink)
      const emp = await Employee.findById(target._id);
      if (!emp) continue;

      const changed = [];
      if (!emp.israeli_id || emp.israeli_id !== israeliId) {
        emp.israeli_id = israeliId;
        changed.push(`israeli_id→${israeliId}`);
      }
      if (xRow.position && !emp.position) {
        emp.position = xRow.position;
        changed.push('position');
      }
      // Move branches if target is different and this is a fuzzy-or-exact match
      if (String(emp.branch_id) !== String(branchDoc._id)) {
        changed.push(`branch→${branchDoc.name}`);
        emp.branch_id = branchDoc._id;
      }

      if (changed.length === 0) {
        summary.matched_skipped++;
        continue;
      }

      if (DRY_RUN) {
        console.log(`  ~ ${fuzzy ? 'FUZZY ' : ''}UPDATE ${emp.full_name}  ${changed.join(', ')}`);
      } else {
        await emp.save(); // triggers post-save hook → auto-relink orphan punches
        console.log(`  ~ ${fuzzy ? 'FUZZY ' : ''}UPDATED ${emp.full_name}  ${changed.join(', ')}`);
      }
      summary.matched_updated++;
      if (fuzzy) summary.fuzzy_matched++;
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log(`  matched & updated: ${summary.matched_updated}${summary.fuzzy_matched ? ` (${summary.fuzzy_matched} via fuzzy)` : ''}`);
  console.log(`  matched & skipped: ${summary.matched_skipped}`);
  console.log(`  created new:        ${summary.created}`);
  console.log(`  branch missing:     ${summary.branch_missing}`);
  console.log(`  ambiguous:          ${summary.ambiguous.length}`);
  for (const a of summary.ambiguous) {
    console.log(`    ${a.xlsx} -> ${a.candidates.join(' | ')}`);
  }

  if (!DRY_RUN) {
    // Count linked punches after import
    const linked = await Punch.countDocuments({ employee_id: { $ne: null } });
    const total = await Punch.countDocuments();
    console.log(`\n  Punches now linked: ${linked}/${total}`);
  }

  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
