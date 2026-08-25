// Guarantee a real global.gc regardless of how the host launches us (Render
// ignores render.yaml's startCommand for this service, and NODE_OPTIONS
// disallows --expose-gc): re-exec ourselves once with the flag. Without a real
// GC, V8 never returns a distribution job's heap to the OS on the 512MB tier
// (measured RSS stuck at 371MB after one big render) and the next Chromium
// launch OOM-kills the instance.
if (!global.gc && !process.env.GC_REEXEC) {
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, ['--expose-gc', __filename], {
    stdio: 'inherit',
    env: { ...process.env, GC_REEXEC: '1' },
  });
  ['SIGTERM', 'SIGINT'].forEach(sig => process.on(sig, () => { try { child.kill(sig); } catch (e) { /* ignore */ } }));
  child.on('exit', (code, sig) => process.exit(code != null ? code : (sig ? 1 : 0)));
  return;
}

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
app.use(helmet({
  // A full policy would have to name every origin the application talks to,
  // and getting one of them wrong takes a working screen off the air for a gan
  // that is open. These four cost nothing and are not about that: they stop
  // the page being framed by somebody else's site, stop a plugin being
  // embedded, stop an injected <base> redirecting every relative link, and
  // stop a form being posted somewhere we did not write.
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      'frame-ancestors': ["'none'"],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
    },
  },
}));
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
    uptime_s: Math.round(process.uptime()), rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    gc: !!global.gc });
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
    const n = Math.min(Math.max(parseInt(req.query.n, 10) || 10, 1), 80);
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

// The console — ours, not a customer's. Served only where the customer layer
// is switched on, and mounted ABOVE the client's catch-all so that /console
// does not fall through and get handed a gan's application shell.
if (require('./platform/connection').isEnabled()) {
  app.use('/console', express.static(path.join(__dirname, '../../console')));

  // The root address, dreamgan.com, is a shop window rather than an
  // application. It has to point at Render — a wildcard certificate is not
  // issued for a domain whose root points somewhere else — so the request
  // arrives here naming no customer, and handing it a gan's login screen it
  // cannot log into is the worst of the available answers.
  //
  // A host that DOES name a customer falls through untouched: this only
  // catches the bare domain and the reserved names.
  const { slugFromHost } = require('./platform/resolve');
  const landing = (file) => (req, res, next) => {
    if (slugFromHost(req.headers.host)) return next();
    res.sendFile(path.join(__dirname, '../../landing', file));
  };
  app.get('/', landing('index.html'));
  // The two documents a network's lawyer asks for before signing anything.
  // On the bare domain only — a customer's own address is their system.
  app.get('/privacy', landing('privacy.html'));
  app.get('/terms', landing('terms.html'));
}

// Serve static frontend in production
if (env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../../client/dist')));
  app.get('*', (req, res) => {
    // A request for a file that is not there is not a page. The catch-all was
    // answering /assets/anything.map with the application's HTML and a 200,
    // which tells anybody probing for source maps that something is there.
    if (/^\/assets\//.test(req.path) || /\.(map|js|css|json|txt|xml|ico|png|jpg|svg|woff2?)$/i.test(req.path)) {
      return res.status(404).type('text/plain').send('Not found');
    }
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

    // Before anything else on a control plane: without a console account
    // nobody can create the first customer, and there is no sign-up screen.
    // A failure here must not stop the server — the customers already on it
    // are served by a process whose console nobody can log into, which is bad;
    // a process that exited would be worse.
    if (require('./platform/connection').isEnabled()) {
      require('./platform/bootstrap').checkConfig();
      require('./platform/bootstrap').seedOwnerFromEnv()
        .catch((e) => console.error('⚠️  יצירת חשבון הבעלים נכשלה:', e.message));
    }

    // There is one database, so a developer running this on a laptop is
    // running it against production — and booting used to mean a Google
    // Sheets sync writing rows, a legacy backfill stamping doc_types, work
    // queued to the branches' Pi agents, mailboxes read, and a טופס 101 scan
    // spending real money at an AI. All from pressing run to look at a screen.
    //
    // DISABLE_JOBS=1 boots the API and nothing else: the routes serve, the
    // schedule stays asleep. Never set in production, where every one of
    // these is the point.
    if (env.DISABLE_JOBS) {
      console.log('⏸  DISABLE_JOBS=1 — scheduled jobs are off (API only)');
      return;
    }

    // ------------------------------------------------------------------
    // On a control plane every job below runs ONCE PER CUSTOMER, inside that
    // customer's models. `each()` is the difference; on a single gan it is the
    // identity and nothing changes.
    //
    // The jobs that read OUR mailbox, OUR spreadsheet or spend on OUR API key
    // do not go through it at all. Run per customer they would read our inbox
    // on somebody else's behalf and file the results in their database, so
    // they stay off here until a customer can carry its own credentials.
    const platformMode = require('./platform/connection').isEnabled();
    const { perTenant } = require('./platform/jobs');
    const each = platformMode ? (label, fn) => perTenant(label, fn) : (label, fn) => fn;
    if (platformMode) {
      console.log('🏢  מצב פלטפורמה — עבודות מתוזמנות ירוצו לכל לקוח בנפרד');
      console.log('    כבויות: סנכרון גיליונות, סיבוס, טופס 101, דיג׳סט גיוס —');
      console.log('    הן ניגשות לתיבת דואר ולמפתחות שלנו, לא של הלקוח.');
    }

    // A distribution job that died with the old process (OOM/deploy restart)
    // must not show "running" forever — close it out with an error entry.
    each('stale-distribution', () =>
      require('./controllers/payslipAudit.controller').finalizeStaleDistributionLogs())();

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

    // First sync after 30 seconds, then every hour. Single-gan only — the
    // spreadsheet it reads is this office's, not a customer's.
    if (!platformMode) {
      setTimeout(runSync, 30000);
      setInterval(runSync, 60 * 60 * 1000);
    }

    // Dead-agent watchdog: alert when a branch's attendance agent (Pi) goes
    // fully silent — the heartbeat-driven clock-down alert can't catch this.
    const { checkStaleAgents } = require('./controllers/agent.controller');
    const staleAgents = each('stale-agents', checkStaleAgents);
    setTimeout(staleAgents, 90000);           // first check after 90s
    setInterval(staleAgents, 60 * 60 * 1000); // then hourly

    // Fingerprint mirroring: a cross-branch employee must be able to put her
    // finger on ANY of her branches' clocks. The sweep captures her template
    // once and pushes it to every branch she works at (no-op when nothing is
    // missing — work already queued is never queued twice).
    const fingerprintSync = require('./services/fingerprintSync');
    const sweep = each('fingerprints', () => fingerprintSync.sweep());
    setTimeout(sweep, 3 * 60 * 1000);       // first pass after 3 min
    setInterval(sweep, 6 * 60 * 60 * 1000); // then every 6h

    // Cibus: pull the scheduled monthly report out of the mailbox. The tick is
    // cheap and self-limiting — it does nothing before the configured day and
    // nothing once the month has already landed — so hourly is fine and means
    // a late email is picked up the same day it arrives.
    const cibusSyncJob = require('./services/cibusSyncJob');
    const runCibus = () => cibusSyncJob.tick().catch(e => console.error('[cibus] tick failed:', e.message));
    if (!platformMode) {
      setTimeout(runCibus, 90 * 1000);
      setInterval(runCibus, 60 * 60 * 1000);
    }

    // טופס 101: the documents that only ever carried the number in their label
    // become typed rows, once. Idempotent — it only touches rows that have no
    // doc_type yet — so it costs a single indexed query on every later boot.
    const form101 = require('./services/form101');
    if (!platformMode) form101.backfillLegacy()
      .then(r => { if (r.converted) console.log(`[form101] converted ${r.converted} legacy documents`); })
      .catch(e => console.error('[form101] backfill failed:', e.message));

    // And the mail scan itself. Same shape as Cibus: cheap when idle (a mailbox
    // read plus a hash lookup per attachment — the AI call only happens for a
    // file never seen before), off until someone enables it.
    const form101Job = require('./services/form101SyncJob');
    const runForm101 = () => form101Job.tick().catch(e => console.error('[form101] tick failed:', e.message));
    if (!platformMode) {
      setTimeout(runForm101, 4 * 60 * 1000);
      setInterval(runForm101, 6 * 60 * 60 * 1000);
    }

    // גיוס: pull the website form's applications out of mail-sorter and mail
    // each manager what is waiting for her. Hourly and self-limiting — nothing
    // before 10:00, nothing once the day's has gone — so a restart at 10:04
    // does not cost a day, and nothing is sent on a morning with no applicants.
    const recruitmentJob = require('./services/recruitmentDigestJob');
    const runRecruitment = () => recruitmentJob.tick()
      .then(r => { if (r?.total) console.log(`[recruitment] digest: ${r.total} candidates in ${r.sent.length} emails`); })
      .catch(e => console.error('[recruitment] tick failed:', e.message));
    if (!platformMode) {
      setTimeout(runRecruitment, 2 * 60 * 1000);
      setInterval(runRecruitment, 60 * 60 * 1000);
    }
  });
});

module.exports = app;
