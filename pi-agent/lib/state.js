/**
 * Local agent state, persisted to a JSON file so the agent can resume across
 * restarts without duplicating punches.
 *
 * Shape:
 *   {
 *     version: 1,
 *     last_user_sn: 19401,         // highest device record ID we've sent to server
 *     last_punches_at: "...",       // last successful punches POST
 *     last_heartbeat_at: "...",     // last successful heartbeat
 *     last_commands_at: "...",      // last successful command poll
 *     bootstrapped: true,           // set true after we baseline on first run
 *   }
 */
const fs = require('fs');
const path = require('path');
const log = require('./logger');

const DEFAULT_STATE = {
  version: 1,
  last_user_sn: 0,
  last_punches_at: null,
  last_heartbeat_at: null,
  last_commands_at: null,
  bootstrapped: false,
};

function loadState(filePath) {
  const abs = path.resolve(filePath);
  try {
    if (fs.existsSync(abs)) {
      const raw = fs.readFileSync(abs, 'utf8');
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_STATE, ...parsed };
    }
  } catch (err) {
    log.error('Failed to load state file, starting from defaults', { file: abs, err: err.message });
  }
  return { ...DEFAULT_STATE };
}

function saveState(filePath, state) {
  const abs = path.resolve(filePath);
  const tmp = abs + '.tmp';
  try {
    // Atomic write: write to temp, rename. Prevents corruption on power loss.
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, abs);
  } catch (err) {
    log.error('Failed to save state file', { file: abs, err: err.message });
  }
}

module.exports = { loadState, saveState, DEFAULT_STATE };
