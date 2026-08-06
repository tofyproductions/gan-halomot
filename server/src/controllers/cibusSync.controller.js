/**
 * Admin surface for the automatic Cibus import.
 *
 * The one thing nobody knows up front is what the scheduled email actually
 * looks like — who Pluxee sends it from, what the subject says, whether the
 * report is attached or linked. So `scan` shows the last few weeks of the
 * mailbox as sender/subject/attachment names and nothing else, and the rules
 * are set from what is actually there rather than guessed in advance.
 */
const { CibusSync } = require('../models');
const job = require('../services/cibusSyncJob');
const mailbox = require('../services/cibusMailbox');

const publicShape = (d) => ({
  enabled: d.enabled,
  from_contains: d.from_contains,
  subject_contains: d.subject_contains,
  mailbox: d.mailbox,
  mark_seen: d.mark_seen,
  month_offset: d.month_offset,
  run_from_day: d.run_from_day,
  last_run_at: d.last_run_at,
  last_success_at: d.last_success_at,
  last_success_month: d.last_success_month,
  last_error: d.last_error,
  runs: (d.runs || []).slice(0, 20),
});

/** GET /api/cibus-sync */
async function get(req, res, next) {
  try {
    const doc = await job.getConfig();
    const cfg = mailbox.mailConfig();
    res.json({
      config: publicShape(doc),
      // Never the password — only whether the server has one at all.
      mail: { configured: cfg.configured, host: cfg.host, user: cfg.user ? maskEmail(cfg.user) : '' },
      next_month: job.targetMonth(doc.month_offset),
    });
  } catch (err) { next(err); }
}

const maskEmail = (e) => String(e).replace(/^(.{2}).*(@.*)$/, (_m, a, b) => `${a}***${b}`);

/** PUT /api/cibus-sync */
async function update(req, res, next) {
  try {
    const doc = await job.getConfig();
    const b = req.body || {};
    const list = (v) => (Array.isArray(v) ? v : String(v || '').split(','))
      .map(s => String(s).trim()).filter(Boolean).slice(0, 20);

    if (b.enabled !== undefined) doc.enabled = !!b.enabled;
    if (b.from_contains !== undefined) doc.from_contains = list(b.from_contains);
    if (b.subject_contains !== undefined) doc.subject_contains = list(b.subject_contains);
    if (b.mailbox !== undefined) doc.mailbox = String(b.mailbox || 'INBOX').slice(0, 80);
    if (b.mark_seen !== undefined) doc.mark_seen = !!b.mark_seen;
    if (b.month_offset !== undefined) {
      const n = Number(b.month_offset);
      if (!Number.isInteger(n) || n < -3 || n > 0) return res.status(400).json({ error: 'היסט חודש חייב להיות בין -3 ל-0' });
      doc.month_offset = n;
    }
    if (b.run_from_day !== undefined) {
      const n = Number(b.run_from_day);
      if (!Number.isInteger(n) || n < 1 || n > 28) return res.status(400).json({ error: 'יום בחודש חייב להיות בין 1 ל-28' });
      doc.run_from_day = n;
    }
    // Turning it on while the server has no mailbox credentials would be a
    // switch that silently does nothing every night.
    if (doc.enabled && !mailbox.mailConfig().configured) {
      return res.status(400).json({ error: 'אי אפשר להפעיל — לשרת אין פרטי תיבת מייל (CIBUS_MAIL_USER / CIBUS_MAIL_PASS)' });
    }
    await doc.save();
    res.json({ config: publicShape(doc) });
  } catch (err) { next(err); }
}

/** POST /api/cibus-sync/test — can the server reach the mailbox at all. */
async function test(req, res, next) {
  try {
    res.json(await mailbox.testConnection());
  } catch (err) { next(err); }
}

/**
 * POST /api/cibus-sync/scan  { days? , applyRules? }
 * What is actually sitting in the mailbox — sender, subject, attachment names.
 * No bodies and no file contents: this is for identifying the report, not for
 * reading anyone's mail through the admin screen.
 */
async function scan(req, res, next) {
  try {
    const days = Math.min(120, Math.max(1, Number(req.body?.days) || 45));
    const doc = await job.getConfig();
    const useRules = req.body?.applyRules === true;
    const res_ = await mailbox.fetchReports({
      fromContains: useRules ? doc.from_contains : [],
      subjectContains: useRules ? doc.subject_contains : [],
      mailbox: doc.mailbox,
      markSeen: false,
      since: new Date(Date.now() - days * 864e5),
      max: 40,
    });
    if (!res_.configured) return res.status(400).json({ error: res_.error });
    res.json({
      days,
      applied_rules: useRules,
      messages: res_.messages.map(m => ({
        from: m.from,
        subject: m.subject,
        date: m.date,
        attachments: m.attachments.map(a => ({ filename: a.filename, size: a.size })),
        has_links: m.bodyLinks.length > 0,
        links: m.bodyLinks.slice(0, 3),
      })),
    });
  } catch (err) { next(err); }
}

/** POST /api/cibus-sync/run  { month?, dryRun? } */
async function run(req, res, next) {
  try {
    const result = await job.runOnce({
      trigger: 'manual',
      month: /^\d{4}-\d{2}$/.test(String(req.body?.month || '')) ? req.body.month : null,
      dryRun: req.body?.dryRun === true,
    });
    res.json({ run: result });
  } catch (err) { next(err); }
}

module.exports = { get, update, test, scan, run };
