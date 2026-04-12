/**
 * Vercel Serverless Function Entry Point
 * Wraps the Express app so it works as a single serverless function
 */

// Load env vars (Vercel provides them automatically, but dotenv handles local dev)
try { require('dotenv').config({ path: require('path').join(__dirname, '../server/.env') }); } catch(e) {}

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const app = express();

// Security & parsing
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.FRONTEND_URL || '*', credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Health check (standalone - no DB needed)
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    platform: 'vercel',
    hasDB: !!process.env.DATABASE_URL,
  });
});

// Lazy-load routes to catch import errors gracefully
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
