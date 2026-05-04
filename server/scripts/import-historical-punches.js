/**
 * One-off: import historical attendance records from a device dump.
 *
 * Input: /tmp/all-attendances.json — produced on the Pi with
 *   node dump-all-attendances.js
 * which calls zk.getAttendances() and dumps every record as
 *   { userSn, deviceUserId, recordTime (ISO UTC), state, verifyMode }
 *
 * For each record we:
 *   1. Normalize deviceUserId to 9-digit israeli_id (pad leading zeros)
 *   2. Find the matching Employee (if any) by israeli_id
 *   3. Upsert into Punch, keyed by (branch_id, device_user_sn), preserving
 *      the DEVICE timestamp (NOT the server/agent receive time)
 *
 * The server-side Punch index { branch_id, device_user_sn } is unique, so
 * re-running this script is safe — it will skip records that already exist.
 *
 * Usage:
 *   node scripts/import-historical-punches.js \
 *     --branch 69dde62467ff14714973a158 \
 *     [--from 2026-03-01] [--to 2026-04-30] [--dry-run]
 *
 * Defaults: no date filter, imports EVERYTHING in the dump.
 */
require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = args[i + 1];
  return (!v || v.startsWith('--')) ? true : v;
}
const BRANCH_ID = arg('branch', null);
const FROM      = arg('from', null);
const TO        = arg('to', null);
const DRY_RUN   = !!arg('dry-run', false);
const INPUT     = arg('input', '/tmp/all-attendances.json');

if (!BRANCH_ID) {
  console.error('--branch <id> is required');
  process.exit(1);
}

function normalizeIsraeliId(v) {
  const digits = String(v || '').replace(/\D/g, '');
  if (digits.length >= 7 && digits.length <= 9) return digits.padStart(9, '0');
  return digits;
}

(async () => {
  const raw = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
  console.log(`Loaded ${raw.length} records from ${INPUT}`);

  await mongoose.connect(process.env.MONGODB_URI);
  const { Punch, Employee, Branch } = require('../src/models');

  const branch = await Branch.findById(BRANCH_ID);
  if (!branch) { console.error(`Branch not found: ${BRANCH_ID}`); process.exit(1); }
  console.log(`Target branch: ${branch.name}`);

  // Preload employees for this branch once to avoid N queries
  const employees = await Employee.find({ branch_id: branch._id, is_active: true })
    .select('_id israeli_id full_name').lean();
  const empByIsraeliId = new Map(employees.map(e => [e.israeli_id, e]));
  console.log(`Cached ${employees.length} active employees (${empByIsraeliId.size} with israeli_id)`);

  // Apply date filter
  const fromMs = FROM ? Date.parse(FROM + 'T00:00:00Z') : -Infinity;
  const toMs   = TO   ? Date.parse(TO   + 'T23:59:59Z') : Infinity;

  let considered = 0, skippedByDate = 0, created = 0, existed = 0;
  let linked = 0, unlinked = 0, errors = 0;
  const stats = { byMonth: {}, byEmployee: {}, unlinkedIds: new Set() };

  // Build the bulk write ops up-front, computing stats along the way. This
  // avoids the previous version's per-record round trip (which on Atlas free
  // tier could take 50-200ms each, turning an 11k-row import into ~20 minutes
  // and putting Render under enough load to OOM-kill it).
  const ops = [];
  for (const rec of raw) {
    const ts = Date.parse(rec.recordTime);
    if (isNaN(ts) || ts < Date.parse('2010-01-01')) { errors++; continue; }
    considered++;
    if (ts < fromMs || ts > toMs) { skippedByDate++; continue; }

    const israeliId = normalizeIsraeliId(rec.deviceUserId);
    if (!israeliId) { errors++; continue; }

    const emp = empByIsraeliId.get(israeliId) || null;
    if (emp) linked++; else { unlinked++; stats.unlinkedIds.add(israeliId); }

    const ym = new Date(ts).toISOString().slice(0, 7);
    stats.byMonth[ym] = (stats.byMonth[ym] || 0) + 1;
    if (emp) stats.byEmployee[emp.full_name] = (stats.byEmployee[emp.full_name] || 0) + 1;

    if (DRY_RUN) continue;

    ops.push({
      updateOne: {
        filter: { branch_id: branch._id, device_user_sn: rec.userSn },
        update: {
          $setOnInsert: {
            branch_id: branch._id,
            device_user_sn: rec.userSn,
            device_user_id: null,
            israeli_id: israeliId,
            employee_id: emp ? emp._id : null,
            timestamp: new Date(ts),
            timestamp_source: 'device', // straight from the clock
            state: Number(rec.state || 0),
            verify_mode: Number(rec.verifyMode || 0),
            received_at: new Date(),
            agent_version: 'historical-import',
          },
        },
        upsert: true,
      },
    });
  }

  if (!DRY_RUN && ops.length > 0) {
    const BATCH = 1000;
    const t0 = Date.now();
    for (let i = 0; i < ops.length; i += BATCH) {
      const slice = ops.slice(i, i + BATCH);
      try {
        // ordered: false → keep going past per-doc errors instead of aborting the batch
        const r = await Punch.bulkWrite(slice, { ordered: false });
        created += r.upsertedCount || 0;
        // matched-but-not-modified == already existed (we use $setOnInsert so no modification on hit)
        existed += (r.matchedCount || 0);
      } catch (e) {
        // Partial failure: bulkWrite throws but the BulkWriteResult is on e.result
        const r = e.result || {};
        created += r.nUpserted || r.upsertedCount || 0;
        existed += r.nMatched || r.matchedCount || 0;
        const writeErrors = e.writeErrors || (r.getWriteErrors && r.getWriteErrors()) || [];
        errors += writeErrors.length;
        if (writeErrors.length && errors < 10) {
          console.error(`bulkWrite (batch ${i}-${i+slice.length}) had ${writeErrors.length} errors; first:`, writeErrors[0].errmsg);
        }
      }
      const done = Math.min(i + BATCH, ops.length);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  bulk progress: ${done} / ${ops.length}  (${elapsed}s)`);
    }
  }

  console.log('\n=== IMPORT SUMMARY ===');
  console.log(`  Considered (within year>=2010): ${considered}`);
  console.log(`  Skipped by date range:          ${skippedByDate}`);
  console.log(`  Created (new punches):          ${created}`);
  console.log(`  Already existed:                ${existed}`);
  console.log(`  Errors:                         ${errors}`);
  console.log(`  Linked to employee:             ${linked}`);
  console.log(`  Unlinked (no matching emp):     ${unlinked}`);
  if (stats.unlinkedIds.size > 0) {
    console.log(`  Unique unlinked israeli_ids:    ${[...stats.unlinkedIds].join(', ')}`);
  }
  console.log('\nBy month:');
  for (const ym of Object.keys(stats.byMonth).sort()) {
    console.log(`  ${ym}: ${stats.byMonth[ym]}`);
  }

  if (Object.keys(stats.byEmployee).length) {
    console.log('\nTop employees by punch count:');
    const top = Object.entries(stats.byEmployee).sort((a, b) => b[1] - a[1]).slice(0, 15);
    for (const [name, n] of top) console.log(`  ${n.toString().padStart(4)}  ${name}`);
  }

  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
