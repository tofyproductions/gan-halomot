/**
 * ג׳וב חלום — its own process, its own port, its own database.
 *
 * ⚠️ THIS FILE IS NEVER LOADED BY THE GAN'S SERVER. That is the whole design.
 *
 * The platform layer switches on inside src/index.js when an environment
 * variable is present, and it is careful about it — but it still means the
 * server that four gans run their day on executes a branch belonging to
 * somebody else's feature. This service does not do that. It is a separate
 * entry point, started by a separate Render service, and src/index.js does not
 * change by one line for it to exist. A bug here cannot reach a gan, because
 * nothing here runs there.
 *
 *   node src/jobgan/index.js
 *
 * Required environment:
 *   JOBGAN_MONGODB_URI   its own database — the name must contain "jobgan"
 *   JOBGAN_JWT_SECRET    its own signing key, never JWT_SECRET
 *   JOBGAN_ADMIN_SECRET  the review queue
 *   JOBGAN_PORT          defaults to 3002
 */

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');

const db = require('./db');
const auth = require('./auth');
const routes = require('./routes');
const sweeper = require('./sweeper');

process.on('unhandledRejection', (err) => console.error('[jobgan] UNHANDLED REJECTION:', err));
process.on('uncaughtException', (err) => console.error('[jobgan] UNCAUGHT EXCEPTION:', err));

const app = express();
const PORT = parseInt(process.env.JOBGAN_PORT || process.env.PORT, 10) || 3002;

app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: false,   // the static front-end is inline-scripted
  crossOriginEmbedderPolicy: false,
}));

/**
 * The board itself is meant to be read by anyone, so GETs are open. Anything
 * that writes carries a token, and a token is only useful from our own origin.
 */
app.use(cors({ origin: true, credentials: false }));

app.use(express.json({ limit: '256kb' }));
app.use(morgan('tiny'));

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'jobgan',
    timestamp: new Date().toISOString(),
    commit: process.env.RENDER_GIT_COMMIT ? process.env.RENDER_GIT_COMMIT.slice(0, 7) : null,
    uptime_s: Math.round(process.uptime()),
  });
});

app.use('/api', routes);

// The public site. Static files, no build step — client/ is shared with the
// gan and is not touched to add a public jobs board to it.
app.use(express.static(path.join(__dirname, 'public')));
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((req, res) => res.status(404).json({ error: 'לא נמצא.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[jobgan]', err);
  res.status(err.status || 500).json({ error: 'שגיאת שרת.' });
});

async function start() {
  // Both refuse to start rather than start wrong: a missing signing key that
  // falls back to a default, or a database name that is somebody else's, are
  // failures that keep serving and are noticed far too late.
  auth.assertSecret();
  await db.connect();
  sweeper.start();
  return new Promise((resolve) => {
    const server = app.listen(PORT, () => {
      console.log(`[jobgan] מאזין על ${PORT}`);
      resolve(server);
    });
  });
}

if (require.main === module) {
  start().catch((err) => {
    console.error('[jobgan] העלייה נכשלה:', err.message);
    process.exit(1);
  });
}

module.exports = { app, start };
