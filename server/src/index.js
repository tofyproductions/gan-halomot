const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const env = require('./config/env');
const { connectDB } = require('./config/database');
const routes = require('./routes');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');

const app = express();

// Security & parsing
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: env.FRONTEND_URL || '*', credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Logging
if (env.NODE_ENV !== 'test') {
  app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'));
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0', db: 'mongodb',
    commit: (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || null });
});

// Diagnostic: can Chromium render a PDF here? (verifies the emailed-report PDF
// path works on this instance without sending an email).
app.get('/api/pdf-selftest', async (req, res) => {
  const t0 = Date.now();
  try {
    const { htmlToPdf } = require('./services/htmlPdf');
    const pdf = await htmlToPdf('<!doctype html><html><body style="font-family:Arial"><h1>PDF OK</h1></body></html>');
    res.json({ ok: true, bytes: pdf.length, ms: Date.now() - t0 });
  } catch (e) {
    res.json({ ok: false, error: e.message, ms: Date.now() - t0 });
  }
});

// API routes
app.use('/api', routes);

// Serve static frontend in production
if (env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../../client/dist')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../../client/dist/index.html'));
  });
}

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

// Connect to MongoDB then start server
connectDB().then(() => {
  app.listen(env.PORT, () => {
    console.log(`🌟 Gan HaHalomot API running on port ${env.PORT} (${env.NODE_ENV})`);

    // Auto-sync from Google Sheets every hour
    const { syncFromSheets } = require('./controllers/sync.controller');
    const runSync = () => {
      console.log('🔄 Auto-sync started...');
      const fakeReq = { query: {}, user: null };
      const fakeRes = {
        json: (data) => console.log('🔄 Auto-sync:', data.summary || 'done'),
        status: () => fakeRes,
      };
      syncFromSheets(fakeReq, fakeRes, (err) => {
        if (err) console.error('🔄 Auto-sync error:', err.message);
      });
    };

    // First sync after 30 seconds, then every hour
    setTimeout(runSync, 30000);
    setInterval(runSync, 60 * 60 * 1000);

    // Dead-agent watchdog: alert when a branch's attendance agent (Pi) goes
    // fully silent — the heartbeat-driven clock-down alert can't catch this.
    const { checkStaleAgents } = require('./controllers/agent.controller');
    setTimeout(checkStaleAgents, 90000);           // first check after 90s
    setInterval(checkStaleAgents, 60 * 60 * 1000); // then hourly
  });
});

module.exports = app;
