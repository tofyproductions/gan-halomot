/**
 * Import a TIMEDOX monthly summary export into our Punch collection so the
 * attendance/salary hours match TIMEDOX (the official source) for a month.
 *
 * Input: a JSON file produced from the TIMEDOX .xlsx exports, shape:
 *   [{ branch, name, israeli_id (9 digits), days: [{ date:'YYYY-MM-DD', in:'HH:MM', out:'HH:MM' }] }]
 *
 * Match employees by israeli_id. For each matched employee, for the target
 * month:
 *   - existing (non-synthetic) punches that month are marked ignored=true
 *     (reason: superseded by TIMEDOX) — reversible, nothing deleted.
 *   - prior TIMEDOX-synthetic punches for that month are removed and rebuilt.
 *   - one synthetic check-in punch per `in` and check-out per `out`
 *     (timestamp_source='manual', manual_note='timedox:<month>').
 *
 * Israel is UTC+3 in May (IDT), so times are written with a +03:00 offset.
 *
 * Run:  node scripts/import-timedox-monthly.js /tmp/timedox_may.json 2026-05 [--apply]
 */
require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const { Employee, Punch, Branch } = require('../src/models');

const MARK = (month) => `timedox:${month}`;

function tsIsrael(date, hhmm) {
  // date 'YYYY-MM-DD', hhmm 'HH:MM' → Date at Israel +03:00
  return new Date(`${date}T${hhmm.padStart(5, '0')}:00+03:00`);
}

async function main() {
  const [jsonPath, month] = process.argv.slice(2);
  const apply = process.argv.includes('--apply');
  if (!jsonPath || !/^\d{4}-\d{2}$/.test(month || '')) {
    console.error('usage: node scripts/import-timedox-monthly.js <json> <YYYY-MM> [--apply]');
    process.exit(2);
  }
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  await mongoose.connect(process.env.MONGODB_URI);

  const monthStart = new Date(`${month}-01T00:00:00+03:00`);
  const [y, m] = month.split('-').map(Number);
  const monthEnd = new Date(`${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01T00:00:00+03:00`);
  const mark = MARK(month);

  // Per-branch synthetic device_user_sn counters (above any real sn).
  const branchSn = new Map();
  async function nextSn(branchId) {
    const key = String(branchId);
    if (!branchSn.has(key)) {
      const top = await Punch.find({ branch_id: branchId }).sort({ device_user_sn: -1 }).limit(1).select('device_user_sn').lean();
      branchSn.set(key, Math.max(1_000_000, (top[0]?.device_user_sn || 0) + 1_000_000));
    }
    const v = branchSn.get(key); branchSn.set(key, v + 1); return v;
  }

  // Branch name → _id (TIMEDOX files are per-branch; a worker can appear in
  // more than one file when they helped at another branch).
  const branches = await Branch.find({}).select('_id name').lean();
  const branchByName = new Map(branches.map(b => [b.name, b._id]));

  // Group all TIMEDOX entries by israeli_id so a multi-branch worker is
  // imported once, with each day tagged to the branch it happened at.
  const byId = new Map();
  for (const e of data) {
    if (!byId.has(e.israeli_id)) byId.set(e.israeli_id, []);
    byId.get(e.israeli_id).push(e);
  }

  const matched = [];
  const unmatched = [];
  for (const [iid, entries] of byId) {
    const emp = await Employee.findOne({ israeli_id: iid, is_active: true })
      .select('_id full_name branch_id israeli_id').lean();
    if (!emp) { unmatched.push({ name: entries.map(e => e.name).join('/'), israeli_id: iid, branch: entries.map(e => e.branch).join(','), days: entries.reduce((s, e) => s + e.days.length, 0) }); continue; }
    const punchDocs = [];
    for (const e of entries) {
      const bid = branchByName.get(e.branch) || emp.branch_id;
      for (const d of e.days) {
        if (d.in) punchDocs.push({ branch_id: bid, date: d.date, hhmm: d.in, state: 0 });
        if (d.out) punchDocs.push({ branch_id: bid, date: d.date, hhmm: d.out, state: 1 });
      }
    }
    matched.push({ emp, punchDocs });
  }

  let totalPunches = 0, totalSupersede = 0, totalInserted = 0;
  for (const { emp, punchDocs } of matched) {
    totalPunches += punchDocs.length;
    const existingReal = await Punch.countDocuments({
      employee_id: emp._id, timestamp: { $gte: monthStart, $lt: monthEnd },
      ignored: { $ne: true }, manual_note: { $ne: mark },
    });
    totalSupersede += existingReal;

    if (!apply) continue;

    // Reversible supersede of existing real punches this month (any branch).
    await Punch.updateMany(
      { employee_id: emp._id, timestamp: { $gte: monthStart, $lt: monthEnd }, ignored: { $ne: true }, manual_note: { $ne: mark } },
      { $set: { ignored: true, ignored_reason: `הוחלף בייבוא טיימדוקס ${month}` } },
    );
    // Rebuild this import idempotently.
    await Punch.deleteMany({ employee_id: emp._id, manual_note: mark, timestamp: { $gte: monthStart, $lt: monthEnd } });

    const docs = [];
    for (const pd of punchDocs) {
      docs.push({
        branch_id: pd.branch_id,
        employee_id: emp._id,
        israeli_id: emp.israeli_id,
        device_user_sn: await nextSn(pd.branch_id),
        device_user_id: null,
        timestamp: tsIsrael(pd.date, pd.hhmm),
        timestamp_source: 'manual',
        state: pd.state,
        manual_note: mark,
        ignored: false,
      });
    }
    if (docs.length) { const r = await Punch.insertMany(docs, { ordered: false }); totalInserted += r.length; }
  }

  console.log(`month: ${month}   mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`TIMEDOX employees in file: ${data.length}`);
  console.log(`matched to active employees: ${matched.length}`);
  console.log(`UNMATCHED (${unmatched.length}):`);
  for (const u of unmatched) console.log(`   ${u.name}  id=${u.israeli_id}  branch=${u.branch}  days=${u.days.length}`);
  console.log(`synthetic punches to create: ${totalPunches}`);
  console.log(`existing real punches superseded: ${totalSupersede}`);
  if (apply) console.log(`inserted: ${totalInserted}`);
  await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
