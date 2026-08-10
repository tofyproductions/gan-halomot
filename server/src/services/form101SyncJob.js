/**
 * The טופס 101 mail scan: read the mailbox, identify the forms, file them.
 *
 * Written against the same failure as the Cibus import — SILENCE. A week where
 * no form arrived looks exactly like a week where the scan was quietly broken,
 * and the cost surfaces a month later as tax deducted at the maximum rate for
 * someone who did file. So every attempt is recorded, including the empty ones,
 * and `last_success_at` is what the staleness warning reads.
 *
 * Two rules keep an automatic filing from doing damage:
 *
 *   Nothing is attached unless the scan says it is a 101. The mailbox also
 *   carries invoices and sick notes, and a supplier's PDF filed as an employee's
 *   tax form is worse than no scan at all.
 *
 *   Anything that cannot be tied to ONE employee goes to the review queue with
 *   the file kept, not dropped with a log line. "I sent it in January" then
 *   costs two clicks instead of asking the person to send it again.
 */
const { Form101Sync, Form101Inbox, EmployeeDocument } = require('../models');
const mailbox = require('./mailbox.service');
const { scanForm101 } = require('./form101Scan');
const form101 = require('./form101');

const RUN_LOG_CAP = 40;

/** The single config document, created with defaults on first use. */
async function getConfig() {
  let doc = await Form101Sync.findOne({ key: 'form101' });
  if (!doc) doc = await Form101Sync.create({ key: 'form101' });
  return doc;
}

async function record(doc, run) {
  doc.last_run_at = new Date();
  if (run.status === 'error') {
    doc.last_error = run.message || 'שגיאה';
  } else {
    doc.last_error = '';
    doc.last_success_at = new Date();
  }
  doc.runs.unshift(run);
  if (doc.runs.length > RUN_LOG_CAP) doc.runs = doc.runs.slice(0, RUN_LOG_CAP);
  await doc.save();
  return run;
}

/**
 * Has this exact file already been handled? Checked against both places a form
 * can end up, so a message re-read inside the lookback window is not attached
 * twice and not queued twice.
 */
async function alreadySeen(hash) {
  const [doc, queued] = await Promise.all([
    EmployeeDocument.exists({ 'mail.hash': hash }),
    Form101Inbox.exists({ hash }),
  ]);
  return !!(doc || queued);
}

/**
 * Run one scan.
 * @param {'schedule'|'manual'} trigger
 */
async function run(trigger = 'schedule') {
  const cfg = await getConfig();

  if (!cfg.enabled && trigger === 'schedule') {
    return { status: 'skipped', message: 'הסריקה מכובה' };
  }

  const since = new Date(Date.now() - (cfg.lookback_days || 30) * 864e5);
  let fetched;
  try {
    fetched = await mailbox.fetchForms({
      fromContains: cfg.from_contains,
      subjectContains: cfg.subject_contains,
      mailbox: cfg.mailbox,
      markSeen: cfg.mark_seen,
      max: cfg.max_messages || 40,
      since,
    });
  } catch (err) {
    return record(cfg, { trigger, status: 'error', message: `קריאת תיבת הדואר נכשלה: ${err.message}` });
  }

  if (!fetched.configured) {
    return record(cfg, { trigger, status: 'error', message: fetched.error || 'תיבת הדואר לא מוגדרת' });
  }

  let filesScanned = 0; let attached = 0; let unmatched = 0; let skipped = 0;
  const problems = [];

  for (const msg of fetched.messages) {
    for (const att of msg.attachments) {
      const hash = form101.hashFile(att.buffer);
      if (await alreadySeen(hash)) { skipped += 1; continue; }

      const data = att.buffer.toString('base64');
      let scan;
      try {
        scan = await scanForm101(data, att.filename, att.contentType);
        filesScanned += 1;
      } catch (err) {
        // A single unreadable attachment must not end the run — the next one
        // may be the form somebody is waiting on.
        problems.push(`${att.filename}: ${err.message}`);
        skipped += 1;
        continue;
      }

      if (!scan.is_form_101) { skipped += 1; continue; }

      const match = await form101.matchEmployee(scan, msg.from, { allowNameMatch: cfg.allow_name_match });

      if (match.employee) {
        // Already filed for that year — by hand, or from a different message.
        // Keep the first one; a second copy is noise in the employee's file.
        const exists = await EmployeeDocument.exists({
          employee_id: match.employee._id,
          doc_type: 'form_101',
          tax_year: scan.tax_year || form101.currentTaxYear(),
        });
        if (exists) { skipped += 1; continue; }

        await form101.attachForm(match.employee, {
          data,
          name: att.filename,
          mimetype: att.contentType || 'application/pdf',
        }, {
          scan,
          source: 'mail',
          matchBasis: match.basis,
          mail: { from: msg.from, subject: msg.subject, date: msg.date, uid: msg.uid, hash },
          description: `שויך אוטומטית מסריקת מייל (${msg.from || 'ללא שולח'})`,
        });
        attached += 1;
      } else {
        await Form101Inbox.create({
          file_data: data,
          file_name: att.filename || '',
          file_mimetype: att.contentType || 'application/pdf',
          hash,
          mail: { from: msg.from, subject: msg.subject, date: msg.date, uid: msg.uid },
          scan: {
            is_form_101: true,
            employee_name: scan.employee_name || '',
            israeli_id: scan.israeli_id || '',
            tax_year: scan.tax_year || null,
            employer_name: scan.employer_name || '',
            signed: !!scan.signed,
            confidence: scan.confidence || '',
            notes: scan.notes || '',
          },
          reason: match.reason || '',
          candidates: match.candidates || [],
        });
        unmatched += 1;
      }
    }
  }

  const status = attached + unmatched === 0 ? 'empty' : 'ok';
  const parts = [];
  if (attached) parts.push(`${attached} שויכו`);
  if (unmatched) parts.push(`${unmatched} ממתינים לשיוך`);
  if (skipped) parts.push(`${skipped} דולגו`);
  if (problems.length) parts.push(`שגיאות: ${problems.slice(0, 3).join('; ')}`);

  return record(cfg, {
    trigger,
    status,
    messages_scanned: fetched.messages.length,
    files_scanned: filesScanned,
    attached_count: attached,
    unmatched_count: unmatched,
    skipped_count: skipped,
    message: parts.join(' · ') || 'לא נמצאו טפסים חדשים',
  });
}

/**
 * The scheduled entry point. Cheap when there is nothing to do — a mailbox read
 * plus a hash lookup per attachment — and the AI call only happens for a file
 * that has never been seen, so re-reading the same 30-day window costs nothing
 * after the first pass.
 */
async function tick() {
  const cfg = await getConfig();
  if (!cfg.enabled) return { status: 'skipped' };
  return run('schedule');
}

module.exports = { run, tick, getConfig };
