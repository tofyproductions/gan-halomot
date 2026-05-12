/**
 * Employee commitments — contracted weekly schedule per employee.
 * CRUD plus a CSV importer that fuzzy-matches employee names from the
 * bookkeeper's "התחייבות שעות עבודה" spreadsheet.
 */
const { EmployeeCommitment, Employee, Branch } = require('../models');

const DAY_LABELS_HE = ["א'", "ב'", "ג'", "ד'", "ה'", "ו'"];

function normalizeName(s) {
  return String(s || '')
    .replace(/[‎‏‪-‮]/g, '') // strip bidi marks
    .replace(/\(.*?\)/g, '')                       // strip parentheticals
    .replace(/[״"׳']/g, '')                        // strip quote marks
    .replace(/\s+/g, ' ')
    .trim();
}

function fuzzyFindEmployee(employees, rawName) {
  const target = normalizeName(rawName);
  if (!target) return null;
  // Exact match first
  let hit = employees.find(e => normalizeName(e.full_name) === target);
  if (hit) return hit;
  // Token-subset match (every token in the CSV name appears in the employee name, or vice versa)
  const tokens = target.split(' ').filter(Boolean);
  hit = employees.find(e => {
    const emp = normalizeName(e.full_name);
    return tokens.every(t => emp.includes(t));
  });
  if (hit) return hit;
  // Reverse: employee tokens all in target (covers maiden/nickname inversions)
  hit = employees.find(e => {
    const empTokens = normalizeName(e.full_name).split(' ').filter(Boolean);
    return empTokens.every(t => target.includes(t));
  });
  return hit || null;
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inside = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inside && line[i + 1] === '"') { cur += '"'; i++; }
      else inside = !inside;
    } else if (ch === ',' && !inside) {
      out.push(cur); cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

async function list(req, res, next) {
  try {
    const filter = {};
    const role = req.user?.role;
    if (role && role !== 'system_admin' && role !== 'accountant') {
      const managed = (req.user.managed_branch_ids || []).map(String);
      const fallback = req.user.branch_id ? [String(req.user.branch_id)] : [];
      const allowed = managed.length > 0 ? managed : fallback;
      if (allowed.length === 0) return res.json({ commitments: [] });
      filter.branch_id = { $in: allowed };
    } else if (req.query.branch && req.query.branch !== 'all') {
      filter.branch_id = req.query.branch;
    }

    const items = await EmployeeCommitment.find(filter)
      .populate('employee_id', 'full_name israeli_id branch_id')
      .populate('branch_id', 'name')
      .lean();
    res.json({ commitments: items.map(c => ({ ...c, id: String(c._id) })) });
  } catch (err) { next(err); }
}

async function upsert(req, res, next) {
  try {
    const { employee_id, branch_id, classroom, days, notes, is_alternating_off, alternating_day } = req.body;
    if (!employee_id) return res.status(400).json({ error: 'employee_id is required' });
    const emp = await Employee.findById(employee_id).select('branch_id').lean();
    if (!emp) return res.status(404).json({ error: 'עובד לא נמצא' });

    const set = {
      employee_id,
      branch_id: branch_id || emp.branch_id,
      classroom: classroom || '',
      days: Array.isArray(days) ? days : [],
      notes: notes || '',
      is_alternating_off: !!is_alternating_off,
      alternating_day: alternating_day ?? null,
    };
    const c = await EmployeeCommitment.findOneAndUpdate(
      { employee_id },
      { $set: set },
      { new: true, upsert: true }
    );
    res.json({ commitment: { ...c.toObject(), id: String(c._id) } });
  } catch (err) { next(err); }
}

async function remove(req, res, next) {
  try {
    await EmployeeCommitment.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
}

/**
 * POST /api/payroll/commitments/import
 * Body: { csv: "...", default_branch_id?: "..." }
 *
 * Parses the bookkeeper's schedule sheet. Returns a per-row report:
 *   { matched: [{ row, employee, commitment }],
 *     unmatched: [{ row, name, classroom, days, raw }] }
 *
 * Matched rows are upserted; unmatched ones are NOT saved — they come back
 * for the admin to manually pick the employee and confirm.
 */
async function importCsv(req, res, next) {
  try {
    const { csv, default_branch_id } = req.body;
    if (!csv) return res.status(400).json({ error: 'csv body required' });

    const lines = csv.split(/\r?\n/);
    const employees = await Employee.find({ is_active: true })
      .select('_id full_name israeli_id branch_id')
      .lean();
    const branches = await Branch.find({}).select('_id name').lean();

    // Map branch name → id, normalized
    const branchByNormName = new Map();
    for (const b of branches) {
      branchByNormName.set(normalizeName(b.name), b._id);
    }

    const matched = [];
    const unmatched = [];
    let currentBranchId = default_branch_id || null;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      if (!line.trim()) continue;
      const cells = parseCsvLine(line).map(c => c.trim());

      // Detect "סניף XXX" rows. Format: first cell starts with "סניף".
      if (cells[0] && cells[0].startsWith('סניף')) {
        const branchName = cells[0].replace(/^סניף\s*/, '').trim();
        const norm = normalizeName(branchName);
        // Try partial match: "אמונה כפר סבא" → "כפר סבא משה דיין" / "כפר סבא קפלן"
        let foundId = branchByNormName.get(norm);
        if (!foundId) {
          for (const [bName, bId] of branchByNormName) {
            if (bName.includes(norm) || norm.includes(bName)) { foundId = bId; break; }
          }
        }
        if (foundId) currentBranchId = foundId;
        continue;
      }

      // Skip header rows: cells[0] is empty AND cells contain header strings
      if (!cells[0] || cells[0] === 'שם מטפלת') continue;
      // Skip the "התחלה / סיום" sub-header row (cells[2..] contain those labels)
      if ((cells[2] || '').includes('התחלה') || (cells[2] || '').includes('סיום')) continue;

      const name = cells[0];
      const classroom = cells[1] || '';

      // Parse 6 day pairs from cells[2..13]
      const days = [];
      let isAlternatingOff = false;
      let alternatingDay = null;
      for (let dayIdx = 0; dayIdx < 6; dayIdx++) {
        const start = (cells[2 + dayIdx * 2] || '').trim();
        const end   = (cells[3 + dayIdx * 2] || '').trim();
        if (!start && !end) continue;
        if (start.includes('חופש לסרוגין') || end.includes('חופש לסרוגין')) {
          days.push({ day: dayIdx, is_off: true, start_hhmm: '', end_hhmm: '' });
          isAlternatingOff = true;
          alternatingDay = dayIdx;
        } else if (start.includes('חופש')) {
          days.push({ day: dayIdx, is_off: true, start_hhmm: '', end_hhmm: '' });
        } else if (/^\d{1,2}:\d{2}$/.test(start)) {
          days.push({ day: dayIdx, is_off: false, start_hhmm: start, end_hhmm: end });
        }
      }

      if (days.length === 0) continue;  // empty row

      const emp = fuzzyFindEmployee(employees, name);
      const rowDescriptor = {
        row_number: lineIdx + 1,
        raw_name: name,
        classroom,
        branch_id: emp?.branch_id ? String(emp.branch_id) : (currentBranchId ? String(currentBranchId) : null),
        days,
        is_alternating_off: isAlternatingOff,
        alternating_day: alternatingDay,
      };

      if (emp) {
        const c = await EmployeeCommitment.findOneAndUpdate(
          { employee_id: emp._id },
          {
            $set: {
              employee_id: emp._id,
              branch_id: emp.branch_id || currentBranchId,
              classroom,
              days,
              is_alternating_off: isAlternatingOff,
              alternating_day: alternatingDay,
            },
          },
          { new: true, upsert: true }
        );
        matched.push({
          ...rowDescriptor,
          employee_id: String(emp._id),
          employee_name: emp.full_name,
          commitment_id: String(c._id),
        });
      } else {
        unmatched.push(rowDescriptor);
      }
    }

    res.json({ matched, unmatched, total: matched.length + unmatched.length });
  } catch (err) { next(err); }
}

/**
 * POST /api/payroll/commitments/link
 * Body: { employee_id, raw_payload: { classroom, days, ... } }
 * Used by the import UI when admin manually picks an employee for a row
 * that fuzzy-match failed on.
 */
async function linkUnmatched(req, res, next) {
  try {
    const { employee_id, classroom, days, is_alternating_off, alternating_day, notes } = req.body;
    if (!employee_id) return res.status(400).json({ error: 'employee_id is required' });
    const emp = await Employee.findById(employee_id).select('branch_id').lean();
    if (!emp) return res.status(404).json({ error: 'עובד לא נמצא' });

    const c = await EmployeeCommitment.findOneAndUpdate(
      { employee_id },
      {
        $set: {
          employee_id,
          branch_id: emp.branch_id,
          classroom: classroom || '',
          days: Array.isArray(days) ? days : [],
          is_alternating_off: !!is_alternating_off,
          alternating_day: alternating_day ?? null,
          notes: notes || '',
        },
      },
      { new: true, upsert: true }
    );
    res.json({ commitment: { ...c.toObject(), id: String(c._id) } });
  } catch (err) { next(err); }
}

module.exports = { list, upsert, remove, importCsv, linkUnmatched };
