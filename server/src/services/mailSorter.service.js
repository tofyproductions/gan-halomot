// ─────────────────────────────────────────────────────────────────────────────
// READING DOCUMENTS OUT OF mail-sorter.
//
// mail-sorter opens the mailboxes once, for both businesses, and works out what
// each attachment is. What גן takes from it costs nothing: a 101 is recognised
// by its sender rule and its ID is read off the filename, with no model
// involved on that side at all.
//
// This file does not read documents and must never start to. The reading of a
// 101 stays in form101Scan, because that read also establishes whether the form
// is SIGNED and who the employer is — facts mail-sorter does not extract and
// which this business genuinely needs. Two systems opening the same INBOX was
// the duplication worth removing; reading the form was never the duplicated
// part.
//
// Nothing is stored here either, which is what lets this work on a service with
// no persistent disk: mail-sorter keeps a pointer into Gmail and serves the
// bytes on demand.
// ─────────────────────────────────────────────────────────────────────────────

const env = require('../config/env');

const BASE = () => String(env.MAIL_SORTER_URL || '').replace(/\/+$/, '');
const TOKEN = () => String(env.MAIL_SORTER_TOKEN || '');

function isConfigured() {
  return Boolean(BASE() && TOKEN());
}

async function call(path, init = {}) {
  if (!isConfigured()) {
    throw new Error('mail-sorter לא מוגדר — חסרים MAIL_SORTER_URL / MAIL_SORTER_TOKEN');
  }
  const res = await fetch(`${BASE()}${path}`, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${TOKEN()}` },
    // A sleeping instance takes a while to answer its first request, and a
    // short default would report the service as down when it is only waking.
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`mail-sorter ענה ${res.status}`);
  return res;
}

/**
 * Documents of one kind that this business may see.
 *
 * `all=1` on purpose. The ack model suits a ledger that files a document once
 * and never wants it again; here the notebook of already-scanned hashes is what
 * prevents rework, and a form that vanished from the list the first time it was
 * fetched could never be re-examined after a fix.
 */
async function listDocuments(docType) {
  const q = new URLSearchParams({ system: 'gan', all: '1' });
  if (docType) q.set('doc_type', docType);
  const res = await call(`/api/pull?${q.toString()}`);
  return res.json();
}

/** The bytes of one document, fetched from Gmail on demand. */
async function fetchFile(id) {
  const res = await call(`/api/pull/${Number(id)}/file`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const disposition = res.headers.get('content-disposition') || '';
  const match = disposition.match(/filename="([^"]+)"/);
  return {
    buffer,
    filename: match ? decodeURIComponent(match[1]) : `document-${id}`,
    mime: res.headers.get('content-type') || 'application/octet-stream',
  };
}

/** "This side has it." Recorded so the other screen can show what is new. */
async function ack(id) {
  await call(`/api/pull/${Number(id)}/ack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ system: 'gan' }),
  });
}

/**
 * The 101 forms, shaped exactly like `mailbox.fetchForms` returns them.
 *
 * A drop-in for the mailbox read and nothing more. Everything the sync job does
 * with these files stays exactly where it is: the hash notebook, the local
 * prefilter, the cheap gate, the full read. Only the source changes.
 */
async function fetchFormsLikeMailbox({ max = 40 } = {}) {
  if (!isConfigured()) return { configured: false, messages: [], error: 'mail-sorter לא מוגדר' };

  const docs = await listDocuments('form101');
  const messages = [];
  for (const d of docs.slice(0, max)) {
    let file;
    try {
      file = await fetchFile(d.id);
    } catch {
      // One document that cannot be fetched must not end the run — the next one
      // may be the form somebody is waiting on.
      continue;
    }
    messages.push({
      uid: d.id,
      from: d.email_from || '',
      subject: d.email_subject || '',
      date: d.email_date || null,
      attachments: [{
        filename: file.filename,
        contentType: file.mime,
        buffer: file.buffer,
        size: file.buffer.length,
      }],
      bodyLinks: [],
      // What mail-sorter already worked out. Carried along for anything that
      // wants it; the sync job does not depend on it.
      sorter: d.extracted || null,
    });
  }
  return { configured: true, messages };
}

module.exports = { isConfigured, listDocuments, fetchFile, ack, fetchFormsLikeMailbox };
