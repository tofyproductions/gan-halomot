/**
 * Minimal structured logger. Writes to stdout/stderr so systemd/journald
 * captures everything. No external deps.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const current = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;

function ts() { return new Date().toISOString(); }

function fmt(level, msg, meta) {
  const base = `${ts()} [${level.toUpperCase()}] ${msg}`;
  if (meta && Object.keys(meta).length) {
    try { return `${base} ${JSON.stringify(meta)}`; }
    catch { return `${base} [unserializable meta]`; }
  }
  return base;
}

function log(level, msg, meta) {
  if (LEVELS[level] < current) return;
  const line = fmt(level, msg, meta);
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

module.exports = {
  debug: (m, meta) => log('debug', m, meta),
  info:  (m, meta) => log('info',  m, meta),
  warn:  (m, meta) => log('warn',  m, meta),
  error: (m, meta) => log('error', m, meta),
};
