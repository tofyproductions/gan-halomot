const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const env = require('./config/env');
const { connectDB } = require('./config/database');
const routes = require('./routes');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');

// On modern Node an unhandled promise rejection TERMINATES the process — a
// background distribution job failing outside its try/catch would crash the
// whole server mid-send (and lose the in-memory job with no log). Log and keep
// serving instead.
process.on('unhandledRejection', (err) => { console.error('UNHANDLED REJECTION:', err); });
process.on('uncaughtException', (err) => { console.error('UNCAUGHT EXCEPTION:', err); });

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
    commit: (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || null,
    uptime_s: Math.round(process.uptime()), rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024) });
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

// Diagnostic: render a REAL multi-employee hours report on this instance and
// report page count + memory — reproduces the exact production send workload
// (the piece that used to OOM) without sending any email.
app.get('/api/pdf-loadtest', async (req, res) => {
  const t0 = Date.now();
  try {
    const month = String(req.query.month || '').trim();
    const n = Math.min(Math.max(parseInt(req.query.n, 10) || 10, 1), 40);
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM' });
    const { Employee } = require('./models');
    const { renderHoursPdfForEmployees } = require('./controllers/payroll.controller');
    const emps = await Employee.find({ is_active: { $ne: false } }).limit(n).select('_id').lean();
    const rss0 = Math.round(process.memoryUsage().rss / 1024 / 1024);
    const pdf = await renderHoursPdfForEmployees(emps.map(e => e._id), month, { role: 'system_admin' });
    const { PDFDocument } = require('pdf-lib');
    const pages = pdf ? (await PDFDocument.load(pdf)).getPageCount() : 0;
    res.json({ ok: true, employees: emps.length, pages, bytes: pdf?.length || 0, ms: Date.now() - t0,
      rss_before_mb: rss0, rss_after_mb: Math.round(process.memoryUsage().rss / 1024 / 1024) });
  } catch (e) {
    res.json({ ok: false, error: e.message, ms: Date.now() - t0 });
  }
});

// Diagnostic: does this Chromium honor CSS page breaks? Renders N full-height
// blocks separated by break-after:page and reports the resulting page count —
// if pages === N the single-render hours report separates employees correctly.
app.get('/api/pdf-pagetest', async (req, res) => {
  const t0 = Date.now();
  const n = Math.min(Math.max(parseInt(req.query.n, 10) || 3, 1), 10);
  try {
    const { htmlToPdf } = require('./services/htmlPdf');
    const { PDFDocument } = require('pdf-lib');
    const blocks = Array.from({ length: n }, (_, i) =>
      `<div style="${i < n - 1 ? 'break-after:page;page-break-after:always;' : ''}break-inside:avoid"><h1>עמוד ${i + 1}</h1></div>`).join('');
    const pdf = await htmlToPdf(`<!doctype html><html dir="rtl"><head><style>@page{size:A4;margin:5mm}</style></head><body>${blocks}</body></html>`);
    const pages = (await PDFDocument.load(pdf)).getPageCount();
    res.json({ ok: true, blocks: n, pages, breaksHonored: pages === n, bytes: pdf.length, ms: Date.now() - t0 });
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

    // A distribution job that died with the old process (OOM/deploy restart)
    // must not show "running" forever — close it out with an error entry.
    require('./controllers/payslipAudit.controller').finalizeStaleDistributionLogs();

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
