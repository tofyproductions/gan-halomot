/**
 * Parse the Ministry of Labor daycare tuition table (מחירון תמ"ת) from its
 * official PDF and recover the PARENT-share matrix (תקינה מורחבת):
 *   rows  = subsidy tiers (דרגות 3–15),
 *   cols  = age groups (0–15 / 15–24 / 24+ months).
 *
 * The PDF's Hebrew is garbled by the embedded font and text extraction is
 * lossy/re-ordered, so we DON'T trust column positions. Instead we lean on a
 * hard invariant of this table: for every cell,
 *     parent_share + government_share = full_tariff
 * and there are exactly 3 full tariffs (one per age group). So we:
 *   1. pull every money number in reading order,
 *   2. detect the 3 tariffs as the most-recurring adjacent-pair sums,
 *   3. emit a parent value ONLY when it + its neighbour equals a tariff
 *      (this guarantees every emitted number is correct — never a wrong cell),
 *   4. align the verified values to tiers by monotonic order, and only
 *      auto-fill an age column when it's fully recovered (8 subsidised tiers
 *      + 2 special tiers). Partial columns are left for manual entry.
 *
 * Mirrors the proven pdf-parse usage in services/payslipAudit/pdfParser.js.
 */

let _PDFParse = null;
async function loadPDFParse() {
  if (_PDFParse) return _PDFParse;
  const mod = await import('pdf-parse');
  _PDFParse = mod.PDFParse || mod.default;
  if (!_PDFParse) throw new Error('pdf-parse: missing PDFParse export');
  return _PDFParse;
}

// Tier rows in the official table (13 is intentionally skipped by the Ministry).
const TIER_LABELS = [
  'דרגה 3', 'דרגה 4', 'דרגה 5', 'דרגה 6', 'דרגה 7', 'דרגה 8',
  'דרגה 9', 'דרגה 10', 'דרגה 11', 'דרגה 12', 'דרגה 14', 'דרגה 15',
];
const AGE_GROUPS = ['עד 15 חודש', '15–24 חודש', 'מעל 24 חודש'];

function extractNumbers(text) {
  let t = text.replace(/[^\x00-\x7f]/g, ' '); // drop garbled-Hebrew glyphs
  t = t.replace(/\d[\d,]*\s*[-–]\s*\d[\d,]*/g, ' '); // drop income ranges (a-b)
  const toks = t.match(/\d{1,3}(?:,\d{3})|\d{3,4}/g) || [];
  return toks
    .map((s) => parseInt(s.replace(/,/g, ''), 10))
    .filter((n) => n >= 300 && n <= 4000);
}

// The 3 full tariffs = the adjacent-pair sums that recur most (>=3 times).
function detectTariffs(nums) {
  const counts = new Map();
  for (let i = 0; i < nums.length - 1; i++) {
    const s = nums[i] + nums[i + 1];
    if (s >= 2000 && s <= 4500) counts.set(s, (counts.get(s) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const tariffs = sorted.filter(([, n]) => n >= 3).slice(0, 3).map(([s]) => s);
  return tariffs.sort((a, b) => b - a); // desc → [0-15, 15-24, 24+]
}

// Walk adjacent pairs; whenever a pair sums to a tariff, the first element is a
// verified parent share for that age group. Returns parent values per age, in
// reading order (which follows tier order top→bottom).
function recoverColumns(nums, tariffs) {
  const ageByTariff = new Map(tariffs.map((t, i) => [t, i]));
  const cols = [[], [], []];
  let i = 0;
  while (i < nums.length - 1) {
    const s = nums[i] + nums[i + 1];
    if (ageByTariff.has(s)) { cols[ageByTariff.get(s)].push(nums[i]); i += 2; }
    else i += 1;
  }
  return cols;
}

function buildMatrix(cols, tariffs) {
  const tiers = TIER_LABELS.map((label) => ({ label, prices: [null, null, null] }));
  const columns = [];
  for (let age = 0; age < 3; age++) {
    const vals = cols[age];
    // Longest strictly-increasing prefix = subsidised tiers 3..10 (parent share
    // rises with income); the trailing lower values are the special tiers 14/15.
    let p = 1;
    while (p < vals.length && vals[p] > vals[p - 1]) p += 1;
    const prefix = vals.slice(0, p);
    const rest = vals.slice(p);
    const complete = prefix.length === 8 && rest.length === 2 && tariffs[age] != null;
    if (complete) {
      for (let k = 0; k < 8; k++) tiers[k].prices[age] = prefix[k]; // 3–10
      tiers[8].prices[age] = tariffs[age]; // 11 = full tariff (no subsidy)
      tiers[9].prices[age] = tariffs[age]; // 12 = full tariff
      tiers[10].prices[age] = rest[0]; // 14
      tiers[11].prices[age] = rest[1]; // 15
    }
    columns.push({ age_group: AGE_GROUPS[age], complete, recovered: vals });
  }
  return { tiers, columns };
}

/**
 * @param {Buffer} buffer  the uploaded תמ"ת PDF
 * @returns {Promise<{ age_groups, tiers, tariffs, columns, recognized }>}
 */
async function parseTmtPdfBuffer(buffer) {
  const PDFParse = await loadPDFParse();
  const parser = new PDFParse({ data: buffer });
  const r = await parser.getText();
  const text = (r.pages || [])
    .map((pg) => (typeof pg === 'string' ? pg : pg.text || ''))
    .join('\n');

  const nums = extractNumbers(text);
  const tariffs = detectTariffs(nums);
  if (tariffs.length < 3) {
    return { recognized: false, age_groups: AGE_GROUPS, tiers: [], tariffs, columns: [] };
  }
  const cols = recoverColumns(nums, tariffs);
  const { tiers, columns } = buildMatrix(cols, tariffs);
  return { recognized: true, age_groups: AGE_GROUPS, tiers, tariffs, columns };
}

module.exports = { parseTmtPdfBuffer };
