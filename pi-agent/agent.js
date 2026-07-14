#!/usr/bin/env node
/**
 * timedox-agent — runs on a Raspberry Pi at each branch, bridges the local
 * TIMEDOX TANDEM4 PRO clock to the gan-halomot server.
 *
 * Three independent loops run concurrently, each with its own interval:
 *   1. poll punches  (POLL_PUNCHES_MS, default 15s)
 *   2. poll commands (POLL_COMMANDS_MS, default 30s)
 *   3. heartbeat     (POLL_HEARTBEAT_MS, default 60s)
 *
 * The agent is designed to be restart-safe: persistent state (highest userSn
 * seen so far) is written to disk after every successful upload, so on
 * restart it resumes exactly where it left off without replaying history
 * or duplicating punches.
 *
 * Usage:
 *   node agent.js            # run continuously (production)
 *   node agent.js --once     # run each loop exactly once and exit (for smoke test)
 *   node agent.js --bootstrap  # baseline last_user_sn from current device state
 *                                and exit (use on first install to skip history)
 */
require('dotenv').config();
const path = require('path');
const log = require('./lib/logger');
const { Clock } = require('./lib/clock');
const { ServerClient } = require('./lib/server');
const { loadState, saveState } = require('./lib/state');

const argv = new Set(process.argv.slice(2));
const ONCE = argv.has('--once');
const BOOTSTRAP = argv.has('--bootstrap');
// --resync: reset the upload baseline so the next poll re-reads the FULL device
// log and re-uploads everything. The server upserts on (branch, device_user_sn)
// so duplicates are ignored; this recovers punches that were below the baseline
// (e.g. records that predate the agent install). Run while the service is
// stopped, then start it:  systemctl stop … && node agent.js --resync && systemctl start …
const RESYNC = argv.has('--resync');

function envRequired(name) {
  const v = process.env[name];
  if (!v) { log.error(`missing required env var: ${name}`); process.exit(2); }
  return v;
}
function envInt(name, def) {
  const v = process.env[name];
  if (v == null || v === '') return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

const cfg = {
  branchId:       envRequired('BRANCH_ID'),
  agentSecret:    envRequired('AGENT_SECRET'),
  serverUrl:      envRequired('SERVER_URL'),
  clockIp:        envRequired('CLOCK_IP'),
  clockPort:      envInt('CLOCK_PORT', 4370),
  clockTimeoutMs: envInt('CLOCK_TIMEOUT_MS', 10000),
  clockInport:    envInt('CLOCK_INPORT', 5200),
  pollPunchesMs:  envInt('POLL_PUNCHES_MS', 15000),
  pollCommandsMs: envInt('POLL_COMMANDS_MS', 30000),
  pollHeartMs:    envInt('POLL_HEARTBEAT_MS', 60000),
  httpTimeoutMs:  envInt('HTTP_TIMEOUT_MS', 15000),
  httpRetryMax:   envInt('HTTP_RETRY_MAX', 5),
  httpRetryBase:  envInt('HTTP_RETRY_BASE_MS', 2000),
  stateFile:      process.env.STATE_FILE || path.join(__dirname, 'state.json'),
  // Default to true: device timestamps are reliable when not zeroed-out (we
  // detect that case below). The old default "false" caused recovery-after-
  // outage punches to be silently misdated to "now". Set env=false on a Pi
  // only if its specific firmware can't be trusted.
  trustDeviceTs:  String(process.env.TRUST_DEVICE_TIMESTAMPS || 'true').toLowerCase() !== 'false',
};

// --- init ---
const clock = new Clock({
  ip: cfg.clockIp,
  port: cfg.clockPort,
  timeoutMs: cfg.clockTimeoutMs,
  inport: cfg.clockInport,
});
const server = new ServerClient({
  serverUrl: cfg.serverUrl,
  branchId: cfg.branchId,
  agentSecret: cfg.agentSecret,
  timeoutMs: cfg.httpTimeoutMs,
  retryMax: cfg.httpRetryMax,
  retryBaseMs: cfg.httpRetryBase,
});
let state = loadState(cfg.stateFile);

if (RESYNC) {
  state.last_user_sn = 0;
  state.bootstrapped = true; // keep bootstrapped so we don't re-baseline to max
  saveState(cfg.stateFile, state);
  log.info('resync: baseline reset to 0 — next run will re-upload the full device log');
  process.exit(0);
}

log.info('agent starting', {
  branchId: cfg.branchId,
  clock: `${cfg.clockIp}:${cfg.clockPort}`,
  server: cfg.serverUrl,
  state: { last_user_sn: state.last_user_sn, bootstrapped: state.bootstrapped },
});

/**
 * Convert a raw node-zklib attendance record to the shape expected by
 * POST /api/agent/:branchId/punches.
 */
function shapePunch(rec) {
  const userSn = Number(rec.userSn);
  const israeliId = String(rec.deviceUserId || rec.userId || '').trim();
  const recordTime = rec.recordTime instanceof Date ? rec.recordTime : new Date(rec.recordTime);

  // Detect the "broken historical timestamp" bug — if the time is before
  // 2010 we know the library's decoder gave us garbage. Fall back to "now".
  // Otherwise trust the device. Using agent-received-now as the default
  // silently turned a 2-day catch-up at Herzliya (2026-05-06) into 21
  // misdated punches; cfg.trustDeviceTs now defaults to true.
  let ts, tsSource;
  const broken = !(recordTime instanceof Date) || isNaN(recordTime.getTime()) || recordTime.getTime() < Date.parse('2010-01-01');
  if (cfg.trustDeviceTs && !broken) {
    ts = recordTime.toISOString();
    tsSource = 'device';
  } else {
    ts = new Date().toISOString();
    tsSource = 'agent_received_at';
  }

  return {
    device_user_sn: userSn,
    device_user_id: Number(rec.deviceUserId) || null,
    israeli_id: israeliId,
    timestamp: ts,
    timestamp_source: tsSource,
    state: Number(rec.state || 0),
    verify_mode: Number(rec.verifyMode || 0),
  };
}

// --- Self-healing: scan local subnet for the clock if it goes missing ---
// Triggered after POLL_FAILURE_THRESHOLD consecutive pollPunches failures.
// Clocks at our branches use DHCP so their LAN IP can change after a power
// cycle; without this the agent would just spam errors forever.
let pollFailureCount = 0;
const POLL_FAILURE_THRESHOLD = 5; // ~75s of consecutive failures @ 15s loop

// Rewrite CLOCK_IP in the .env file so a DHCP-driven IP change survives a
// restart (otherwise the agent reverts to the old, dead IP on reboot).
const ENV_PATH = path.join(__dirname, '.env');
function persistClockIp(newIp) {
  try {
    const fs = require('fs');
    let txt = fs.readFileSync(ENV_PATH, 'utf8');
    txt = /^CLOCK_IP=.*$/m.test(txt)
      ? txt.replace(/^CLOCK_IP=.*$/m, `CLOCK_IP=${newIp}`)
      : txt + `\nCLOCK_IP=${newIp}\n`;
    fs.writeFileSync(ENV_PATH, txt);
    log.info('persisted new CLOCK_IP to .env', { clockIp: newIp });
  } catch (e) {
    log.error('failed to persist CLOCK_IP', { err: e.message });
  }
}

async function discoverClockIp() {
  const os = require('os');
  const net = require('net');
  const ifaces = os.networkInterfaces();
  // Pick the real branch-LAN address — NOT the Tailscale/VPN overlay. Earlier
  // this grabbed tailscale0 (100.x CGNAT) and scanned the wrong subnet, so the
  // clock was never found after a DHCP IP change. Skip overlay interfaces and
  // require an RFC-1918 private LAN address.
  const isPrivateLan = (ip) =>
    /^10\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  let myIp = null;
  for (const [name, list] of Object.entries(ifaces || {})) {
    if (/^(tailscale|tun|wg|docker|zt|utun)/i.test(name)) continue; // overlay/VPN
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && isPrivateLan(a.address)) { myIp = a.address; break; }
    }
    if (myIp) break;
  }
  if (!myIp) { log.warn('discoverClockIp: no private-LAN IP'); return null; }
  const subnet = myIp.split('.').slice(0, 3).join('.');
  log.warn('discoverClockIp: scanning subnet', { subnet, port: cfg.clockPort, currentIp: clock.ip });

  const probe = (ip) => new Promise(resolve => {
    const sock = net.createConnection({ host: ip, port: cfg.clockPort, timeout: 800 });
    sock.once('connect', () => { sock.destroy(); resolve(ip); });
    sock.once('error',   () => { try { sock.destroy(); } catch(e){} resolve(null); });
    sock.once('timeout', () => { try { sock.destroy(); } catch(e){} resolve(null); });
  });

  const found = [];
  for (let start = 1; start <= 254; start += 32) {
    const batch = [];
    for (let i = start; i < start + 32 && i <= 254; i++) {
      const ip = `${subnet}.${i}`;
      if (ip !== myIp) batch.push(ip);
    }
    const results = await Promise.all(batch.map(probe));
    for (const r of results) if (r) found.push(r);
  }
  log.warn('discoverClockIp: scan complete', { found, currentIp: clock.ip });
  // Prefer something different from the IP we currently have (since that one isn't responding)
  return found.find(ip => ip !== clock.ip) || found[0] || null;
}

async function pollPunches() {
  try {
    const raws = await clock.getAttendances();
    if (!raws || raws.length === 0) {
      pollFailureCount = 0;
      log.debug('no attendances returned from device');
      return;
    }

    const lastSeen = state.last_user_sn || 0;

    pollFailureCount = 0; // success — reset

    // Exclude TIMEDOX test/demo users (device UID 0-9, used while installing a
    // clock). They carry broken pre-2010 timestamps, so uploading them would
    // misdate them to "now"; the server also flags them ignored, but skipping
    // here keeps them out of the DB entirely.
    const fresh = raws
      .filter(r => typeof r.userSn === 'number' && r.userSn > lastSeen && r.deviceUserId
        && Number(r.deviceUserId) > 9)
      .sort((a, b) => a.userSn - b.userSn);

    if (fresh.length === 0) {
      log.debug('no new punches', { lastSeen, total: raws.length });
      return;
    }

    // Bootstrap protection: if we've never uploaded before and the device
    // already has 19,000+ records, we DO NOT dump them all — that's historical
    // data from TIMEDOX. We baseline to the max userSn and the next new punch
    // will be the first real one for our system. This is what `--bootstrap`
    // does explicitly, but we also do it automatically the very first time.
    if (!state.bootstrapped) {
      const maxSn = Math.max(...raws.map(r => Number(r.userSn) || 0));
      state.last_user_sn = maxSn;
      state.bootstrapped = true;
      saveState(cfg.stateFile, state);
      log.info('bootstrapped: baselined last_user_sn, skipping historical', {
        last_user_sn: maxSn, history_skipped: raws.length,
      });
      return;
    }

    const shaped = fresh.map(shapePunch);
    log.info(`uploading ${shaped.length} new punches`, {
      first_sn: shaped[0].device_user_sn,
      last_sn: shaped[shaped.length - 1].device_user_sn,
    });

    const result = await server.uploadPunches(shaped);
    log.info('punches uploaded', result);

    // Only advance last_user_sn after a successful upload. If upload fails,
    // we'll retry the same punches on the next loop.
    state.last_user_sn = shaped[shaped.length - 1].device_user_sn;
    state.last_punches_at = new Date().toISOString();
    saveState(cfg.stateFile, state);
  } catch (err) {
    log.error('pollPunches failed', { err: err.message });
    pollFailureCount++;
    if (pollFailureCount >= POLL_FAILURE_THRESHOLD) {
      pollFailureCount = 0;  // reset so we don't loop on every failure
      try {
        const newIp = await discoverClockIp();
        if (newIp && newIp !== clock.ip) {
          log.warn('clock IP changed (DHCP) — switching and persisting', {
            from: clock.ip, to: newIp,
          });
          clock.ip = newIp;
          persistClockIp(newIp); // make it survive a restart/reboot
        } else if (!newIp) {
          log.error('discoverClockIp: no clock found on local subnet');
        }
      } catch (e) {
        log.error('discoverClockIp threw', { err: e.message });
      }
    }
  }
}

async function pollHeartbeat() {
  try {
    // Light probe of the device — don't fail the heartbeat if the clock is
    // temporarily unreachable; the server still needs to know the agent is
    // alive, even if the clock is down.
    let clockInfo = null;
    let clockReachable = false;
    try {
      clockInfo = await clock.getInfo();
      clockReachable = true;
    } catch (e) {
      log.warn('clock unreachable during heartbeat', { err: e.message });
    }
    const payload = {
      clock_reachable: clockReachable,
      clock_user_count:   clockInfo && (clockInfo.userCounts || clockInfo.users) || null,
      clock_log_count:    clockInfo && (clockInfo.logCounts  || clockInfo.logs)  || null,
      last_user_sn: state.last_user_sn,
    };
    const res = await server.heartbeat(payload);
    state.last_heartbeat_at = new Date().toISOString();
    saveState(cfg.stateFile, state);
    log.debug('heartbeat ok', res);
  } catch (err) {
    log.error('pollHeartbeat failed', { err: err.message });
  }
}

async function pollCommands() {
  try {
    const res = await server.pendingCommands();
    state.last_commands_at = new Date().toISOString();
    saveState(cfg.stateFile, state);
    const commands = (res && res.commands) || [];
    if (!commands.length) {
      log.debug('no pending commands');
      return;
    }
    for (const cmd of commands) {
      log.info('received command', { id: cmd.id, type: cmd.type });
      try {
        if (cmd.type === 'ping') {
          await server.commandResult(cmd.id, 'confirmed', { result: { pong: true, at: new Date().toISOString() } });

        } else if (cmd.type === 'add_user') {
          const { israeli_id, name, privilege = 0, password = '', cardno = 0 } = cmd.payload || {};
          if (!israeli_id) {
            await server.commandResult(cmd.id, 'failed', { error: 'missing israeli_id in payload' });
            continue;
          }
          // Find next available UID by checking existing users
          const users = await clock.getUsers();
          const usedUids = users.map(u => u.uid || 0);
          let uid = 1;
          while (usedUids.includes(uid)) uid++;
          // Use israeli_id as the device userId
          await clock.setUser(uid, israeli_id, name || '', password || '', privilege, cardno);
          log.info(`add_user OK: uid=${uid} userId=${israeli_id} name=${name}`);
          await server.commandResult(cmd.id, 'confirmed', { result: { uid, israeli_id, name } });

        } else if (cmd.type === 'delete_user') {
          const { uid } = cmd.payload || {};
          if (!uid) {
            await server.commandResult(cmd.id, 'failed', { error: 'missing uid in payload' });
            continue;
          }
          await clock.deleteUser(uid);
          log.info(`delete_user OK: uid=${uid}`);
          await server.commandResult(cmd.id, 'confirmed', { result: { uid } });

        } else if (cmd.type === 'export_template') {
          // READ-ONLY: extract a user's fingerprint templates from THIS device
          // (matched by Israeli ID) so the server can later import them onto
          // another branch's clock. Does not modify the device.
          const { israeli_id } = cmd.payload || {};
          if (!israeli_id) {
            await server.commandResult(cmd.id, 'failed', { error: 'missing israeli_id in payload' });
            continue;
          }
          const r = await clock.getUserTemplates(israeli_id);
          if (!r.found) {
            await server.commandResult(cmd.id, 'failed', { error: r.reason || 'user_not_on_device', israeli_id });
            continue;
          }
          log.info(`export_template OK: userId=${israeli_id} uid=${r.user.uid} fingers=${r.templates.length}`);
          await server.commandResult(cmd.id, 'confirmed', {
            result: {
              israeli_id,
              uid: r.user.uid,
              name: r.user.name,
              finger_count: r.templates.length,
              templates: r.templates,
            },
          });

        } else if (cmd.type === 'sync_time') {
          // Future: await clock.setTime(new Date());
          await server.commandResult(cmd.id, 'failed', { error: 'sync_time not yet implemented' });

        } else {
          await server.commandResult(cmd.id, 'failed', {
            error: `command type '${cmd.type}' not supported by agent ${require('./package.json').version}`,
          });
        }
      } catch (cmdErr) {
        log.error(`command ${cmd.id} (${cmd.type}) failed`, { err: cmdErr.message });
        await server.commandResult(cmd.id, 'failed', { error: cmdErr.message }).catch(() => {});
      }
    }
  } catch (err) {
    log.error('pollCommands failed', { err: err.message });
  }
}

// --- bootstrap mode ---
async function doBootstrap() {
  log.info('bootstrap mode: baselining last_user_sn from device');
  const raws = await clock.getAttendances();
  const maxSn = raws.reduce((m, r) => Math.max(m, Number(r.userSn) || 0), 0);
  state.last_user_sn = maxSn;
  state.bootstrapped = true;
  saveState(cfg.stateFile, state);
  log.info('bootstrap done', { last_user_sn: maxSn, device_record_count: raws.length });
}

// --- main ---
async function main() {
  if (BOOTSTRAP) {
    await doBootstrap();
    process.exit(0);
  }

  if (ONCE) {
    log.info('running each loop once');
    await pollHeartbeat();
    await pollPunches();
    await pollCommands();
    log.info('one-shot run done');
    process.exit(0);
  }

  // Run each loop with its own setInterval. Kick each one off immediately
  // so we don't have to wait a full interval before the first call.
  const schedule = (fn, ms) => {
    // Fire-and-forget; each call protects itself with try/catch.
    fn();
    setInterval(fn, ms);
  };

  schedule(pollHeartbeat, cfg.pollHeartMs);
  // Stagger the other two loops slightly so we don't hit the clock
  // simultaneously from multiple async paths.
  setTimeout(() => schedule(pollPunches,  cfg.pollPunchesMs),  2000);
  setTimeout(() => schedule(pollCommands, cfg.pollCommandsMs), 4000);

  // Graceful shutdown — flush state before exit.
  const shutdown = (sig) => {
    log.info(`received ${sig}, shutting down`);
    saveState(cfg.stateFile, state);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  log.error('fatal in main', { err: err.message, stack: err.stack });
  process.exit(1);
});
