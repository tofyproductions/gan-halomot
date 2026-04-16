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
  trustDeviceTs:  String(process.env.TRUST_DEVICE_TIMESTAMPS || 'false').toLowerCase() === 'true',
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

async function pollPunches() {
  try {
    const raws = await clock.getAttendances();
    if (!raws || raws.length === 0) {
      log.debug('no attendances returned from device');
      return;
    }

    const lastSeen = state.last_user_sn || 0;
    const fresh = raws
      .filter(r => typeof r.userSn === 'number' && r.userSn > lastSeen && r.deviceUserId)
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
