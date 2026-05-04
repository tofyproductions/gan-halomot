#!/usr/bin/env node
/**
 * One-off dump tool. Reads ALL attendance records from the TIMEDOX clock
 * (uses the same Clock wrapper as the agent) and writes a JSON array to
 * /tmp/all-attendances.json (or --out <path>).
 *
 * Output format matches what server/scripts/import-historical-punches.js
 * expects:
 *   { userSn, deviceUserId, recordTime (ISO UTC), state, verifyMode }
 *
 * IMPORTANT: stop the agent first so the two processes don't both hold the
 * single device socket at the same time:
 *   sudo systemctl stop timedox-agent
 *   node scripts/dump-all-attendances.js
 *   sudo systemctl start timedox-agent
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const fs = require('fs');
const { Clock } = require('../lib/clock');

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = argv[i + 1];
  return (!v || v.startsWith('--')) ? true : v;
}
const OUT = arg('out', '/tmp/all-attendances.json');

(async () => {
  const clock = new Clock({
    ip: process.env.CLOCK_IP,
    port: parseInt(process.env.CLOCK_PORT || '4370', 10),
    timeoutMs: parseInt(process.env.CLOCK_TIMEOUT_MS || '10000', 10),
    inport: parseInt(process.env.CLOCK_INPORT || '5200', 10),
  });

  console.log(`Connecting to clock at ${process.env.CLOCK_IP}:${process.env.CLOCK_PORT || 4370}...`);
  const raw = await clock.getAttendances();
  console.log(`Got ${raw.length} raw records from device`);

  // Normalize to the shape expected by import-historical-punches.js
  const records = raw.map(r => ({
    userSn:       r.userSn,
    deviceUserId: r.deviceUserId,
    recordTime:   r.recordTime instanceof Date
                    ? r.recordTime.toISOString()
                    : new Date(r.recordTime).toISOString(),
    state:        r.state,
    verifyMode:   r.verifyMode,
    ip:           r.ip,
  }));

  // Quick sanity stats so we notice if timestamps look broken
  const tsValid = records.filter(r => Date.parse(r.recordTime) > Date.parse('2020-01-01')).length;
  const tsBroken = records.length - tsValid;
  const userSns = records.map(r => r.userSn);
  console.log(`Timestamps: ${tsValid} valid (>2020), ${tsBroken} broken`);
  console.log(`userSn range: ${Math.min(...userSns)} → ${Math.max(...userSns)}`);

  fs.writeFileSync(OUT, JSON.stringify(records, null, 2));
  console.log(`Wrote ${OUT}`);
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
