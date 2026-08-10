/**
 * Reading a mailbox over IMAP — the one piece of the system that touches mail
 * credentials.
 *
 * It started as the Cibus report fetcher: Cibus can email the monthly employer
 * report on a schedule, which is a far better integration than scraping their
 * portal — it does not break when they redesign the site, and it needs no
 * stored session. The טופס 101 scan reads the SAME mailbox, so rather than a
 * second copy of the IMAP dance with a second set of credentials, the fetch is
 * generic and each caller says which attachments it wants.
 *
 * Credentials live ONLY in the environment (Render env vars), never in Mongo
 * and never in a request body — a mail password that can be read back out of
 * the admin UI is a mail password that leaks with the admin UI.
 *
 *   CIBUS_MAIL_HOST   imap.gmail.com
 *   CIBUS_MAIL_PORT   993
 *   CIBUS_MAIL_USER   the mailbox that is read
 *   CIBUS_MAIL_PASS   an app password, not the account password
 *
 * The names still say CIBUS because that is what is configured in Render and
 * renaming a secret in place is how a deploy loses a mailbox.
 *
 * The matching rules (who it is from, what the subject looks like) are config,
 * not secrets, so those live in the CibusSync / Form101Sync documents and can
 * be corrected without a deploy — which matters, because the first run is
 * where you find out what the email actually looks like.
 */

const REPORT_EXT = /\.(xlsx|xls|csv)$/i;
/** What a filed טופס 101 arrives as: a scan, a photo, or an exported PDF. */
const FORM_EXT = /\.(pdf|png|jpe?g|gif|webp|heic)$/i;

function mailConfig() {
  const host = process.env.CIBUS_MAIL_HOST || 'imap.gmail.com';
  const port = Number(process.env.CIBUS_MAIL_PORT) || 993;
  const user = process.env.CIBUS_MAIL_USER;
  const pass = process.env.CIBUS_MAIL_PASS;
  return { host, port, user, pass, configured: !!(user && pass) };
}

/**
 * Look through the mailbox and return the matching messages with the
 * attachments the caller asked for.
 *
 * @param {Object} rules
 * @param {String[]} rules.fromContains    any-of match on the sender
 * @param {String[]} rules.subjectContains any-of match on the subject
 * @param {Date}     rules.since           don't look further back than this
 * @param {Boolean}  rules.markSeen        mark handled mail as read
 * @param {Number}   rules.max             stop after this many matching messages
 * @param {RegExp}   rules.attachmentExt   which attachments to keep (default: spreadsheets)
 * @returns {{ configured, messages: [{ uid, from, subject, date, attachments: [{ filename, buffer }] , bodyLinks: string[] }] }}
 */
async function fetchMessages(rules = {}) {
  const cfg = mailConfig();
  if (!cfg.configured) {
    return { configured: false, messages: [], error: 'CIBUS_MAIL_USER / CIBUS_MAIL_PASS לא מוגדרים' };
  }
  const keepExt = rules.attachmentExt || REPORT_EXT;

  const { ImapFlow } = require('imapflow');
  const { simpleParser } = require('mailparser');

  const from = (rules.fromContains || []).filter(Boolean).map(s => s.toLowerCase());
  const subject = (rules.subjectContains || []).filter(Boolean).map(s => s.toLowerCase());
  const since = rules.since || new Date(Date.now() - 45 * 864e5);
  const max = rules.max || 10;

  const client = new ImapFlow({
    host: cfg.host, port: cfg.port, secure: true,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
  });

  const messages = [];
  await client.connect();
  const lock = await client.getMailboxLock(rules.mailbox || 'INBOX');
  try {
    // Search on the server by date only; sender/subject are matched here so a
    // rule can be a substring in either Hebrew or English without depending on
    // the server's SEARCH charset handling.
    for await (const msg of client.fetch({ since }, { uid: true, envelope: true, source: true })) {
      const env = msg.envelope || {};
      const senders = [...(env.from || []), ...(env.sender || [])]
        .map(a => `${a.name || ''} <${a.address || ''}>`.toLowerCase());
      const subj = (env.subject || '').toLowerCase();

      if (from.length && !from.some(f => senders.some(s => s.includes(f)))) continue;
      if (subject.length && !subject.some(t => subj.includes(t))) continue;

      const parsed = await simpleParser(msg.source);
      const attachments = (parsed.attachments || [])
        .filter(a => keepExt.test(a.filename || ''))
        .map(a => ({
          filename: a.filename,
          buffer: a.content,
          size: a.size,
          contentType: a.contentType || '',
        }));

      // If Cibus sends a download link instead of a file, the link is what the
      // next step needs — surface it rather than reporting "no attachment".
      const bodyLinks = [...new Set(
        (String(parsed.text || '') + ' ' + String(parsed.html || ''))
          .match(/https?:\/\/[^\s"'<>]+/g) || [],
      )].filter(u => /download|report|export|file|attach|xls|csv/i.test(u)).slice(0, 10);

      messages.push({
        uid: msg.uid,
        from: env.from?.[0]?.address || '',
        subject: env.subject || '',
        date: env.date || parsed.date || null,
        attachments,
        bodyLinks,
      });
      if (messages.length >= max) break;
    }

    if (rules.markSeen && messages.length) {
      await client.messageFlagsAdd({ uid: messages.map(m => m.uid).join(',') }, ['\\Seen'], { uid: true });
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }

  return { configured: true, messages };
}

/** Connect and disconnect — used by the "test connection" button. */
async function testConnection() {
  const cfg = mailConfig();
  if (!cfg.configured) return { ok: false, error: 'CIBUS_MAIL_USER / CIBUS_MAIL_PASS לא מוגדרים בשרת' };
  const { ImapFlow } = require('imapflow');
  const client = new ImapFlow({
    host: cfg.host, port: cfg.port, secure: true,
    auth: { user: cfg.user, pass: cfg.pass }, logger: false,
  });
  try {
    await client.connect();
    const box = await client.mailboxOpen('INBOX');
    await client.logout();
    return { ok: true, mailbox: cfg.user, host: cfg.host, messages: box.exists };
  } catch (err) {
    try { await client.logout(); } catch { /* already down */ }
    return { ok: false, error: err.message };
  }
}

/** The Cibus import's view: spreadsheets only. */
const fetchReports = (rules = {}) => fetchMessages({ ...rules, attachmentExt: REPORT_EXT });

/** The טופס 101 scan's view: PDFs and photographed/scanned pages. */
const fetchForms = (rules = {}) => fetchMessages({ ...rules, attachmentExt: FORM_EXT });

module.exports = { fetchMessages, fetchReports, fetchForms, testConnection, mailConfig, FORM_EXT, REPORT_EXT };
