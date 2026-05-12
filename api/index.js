/**
 * Vercel Serverless Function Entry Point
 * Wraps the Express app so it works as a single serverless function.
 *
 * Mongo connection is cached across invocations (the module is loaded once
 * per warm container) so we don't pay the connect handshake on every request.
 */

try { require('dotenv').config({ path: require('path').join(__dirname, '../server/.env') }); } catch(e) {}

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const mongoose = require('mongoose');

const app = express();

// Security & parsing
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.FRONTEND_URL || '*', credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ── Lazy DB connection (cached) ──
// Serverless: the module is loaded fresh per cold-start container, but stays
// alive for subsequent warm requests. Cache the connect promise so we connect
// once per container and never block on duplicate handshakes.
let _dbPromise = null;
function connectIfNeeded() {
  if (mongoose.connection.readyState === 1) return Promise.resolve();
  if (_dbPromise) return _dbPromise;
  if (!process.env.MONGODB_URI) return Promise.resolve(); // health endpoint still works
  _dbPromise = mongoose.connect(process.env.MONGODB_URI).catch((err) => {
    _dbPromise = null;
    throw err;
  });
  return _dbPromise;
}

// Health check (no DB needed — useful for smoke tests)
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    platform: 'vercel',
    hasDB: mongoose.connection.readyState === 1,
    mongoUriSet: !!process.env.MONGODB_URI,
  });
});

// Ensure DB is connected before any /api route handler runs.
app.use('/api', async (req, res, next) => {
  if (req.path === '/health') return next();
  try {
    await connectIfNeeded();
    next();
  } catch (err) {
    res.status(503).json({ error: 'Database unavailable', detail: err.message });
  }
});

// Lazy-load routes — surface import errors as 500s instead of 502 cold-start.
try {
  const routes = require('../server/src/routes');
  const { errorHandler, notFoundHandler } = require('../server/src/middleware/errorHandler');
  app.use('/api', routes);
  app.use(notFoundHandler);
  app.use(errorHandler);
} catch (err) {
  console.error('Failed to load routes:', err);
  app.use('/api', (req, res) => {
    res.status(500).json({ error: 'Server initialization failed', detail: err.message });
  });
}

module.exports = app;
