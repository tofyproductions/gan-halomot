/**
 * Vercel Serverless Function Entry Point
 * Wraps the Express app so it works as a single serverless function
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const routes = require('../server/src/routes');
const { errorHandler, notFoundHandler } = require('../server/src/middleware/errorHandler');

const app = express();

// Security & parsing
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.FRONTEND_URL || '*', credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0', platform: 'vercel' });
});

// API routes
app.use('/api', routes);

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
