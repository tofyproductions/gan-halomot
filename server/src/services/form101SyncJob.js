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
const {
  Form101Sync, Form101Inbox, EmployeeDocument, ScannedAttachment,
} = require('../models');
const mailbox = require('./mailbox.service');
const { scanForm101, gateIsForm101 } = require('./form101Scan');
const { prefilter } = require('./form101Prefilter');
const { newLedger } = require('./aiCost');
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
 * Has this exact file already been handled?
 *
 * Three places, not two. The first two are where a form ENDS UP — attached to
 * an employee, or waiting in the queue — and they were the whole check. The
 * third is where a file the AI already REJECTED is remembered, and its absence
 * is what made every scan pay again for the same payslips: a file that is not
 * a form 101 was recorded nowhere, so the next run had no way to know it had
 * ever been asked.
 *
 * An `unreadable` verdict is not final — the scan can fail because the model
 * was briefly unavailable — so it is retried, but only MAX_ATTEMPTS times.
 */
async function alreadySeen(hash) {
  const [doc, queued, judged] = await Promise.all([
    EmployeeDocument.exists({ 'mail.hash': hash }),
    Form101Inbox.exists({ hash }),
    ScannedAttachment.findOne({ hash }).select('verdict attempts').lean(),
  ]);
  if (doc || queued) return { seen: true, cached: false };
  if (!judged) return { seen: false, cached: false };
  if (judged.verdict === 'unreadable' && (judged.attempts || 0) < ScannedAttachment.MAX_ATTEMPTS) {
    return { seen: false, cached: false };
  }
  return { seen: true, cached: true, verdict: judged.verdict };
}

/**
 * Write down what the AI said about a file, so it is never asked twice.
 *
 * Upserted on the hash: the same file arriving in two different messages is
 * one verdict and one row, with a count of how often it has come back — which
 * is the saving, in a number.
 */
async function remember(hash, verdict, att, note = '') {
  await ScannedAttachment.updateOne(
    { hash },
    {
      $set: {
        verdict,
        source: 'form101',
        file_name: att?.filename || '',
        mimetype: att?.contentType || '',
        size: att?.size ?? null,
        note,
        last_seen_at: new Date(),
      },
      $inc: { times_seen: 1, attempts: verdict === 'unreadable' ? 1 : 0 },
      $setOnInsert: { first_seen_at: new Date() },
    },
    { upsert: true },
  );
}

/**
 * Is a scan in flight right now?
 *
 * One instance, one mailbox, one lock. Two scans at once would read the same
 * messages twice and — before the notebook has recorded anything about them —
 * pay for the same files twice. It also stops a scheduled tick from landing on
 * top of a scan somebody started by hand.
 */
let inFlight = false;

/** Whether a scan is currently running — for the endpoint that starts one. */
const isRunning = () => inFlight;

/**
 * Run one scan.
 * @param {'schedule'|'manual'} trigger
 */
async function run(trigger = 'schedule') {
  if (inFlight) {
    return { status: 'skipped', message: 'סריקה כבר רצה כרגע' };
  }
  inFlight = true;
  try {
    return await runOnce(trigger);
  } finally {
    inFlight = false;
  }
}

async function runOnce(trigger) {
  const cfg = await getConfig();

  if (!cfg.enabled && trigger === 'schedule') {
    return { status: 'skipped', message: 'הסריקה מכובה' };
  }

  /**
   * A scheduled run too soon after the last one is not a run.
   *
   * The scan fires four minutes after every boot and Render boots on every
   * deploy, so a busy afternoon of deploys turned into a full thirty-day scan
   * per deploy. A person pressing "סרוק עכשיו" is never throttled — they are
   * asking for precisely this.
   */
  if (trigger === 'schedule' && cfg.last_run_at) {
    const minutes = (Date.now() - new Date(cfg.last_run_at).getTime()) / 60000;
    const floor = cfg.min_interval_minutes ?? 60;
    if (minutes < floor) {
      return { status: 'skipped', message: `נסרק לפני ${Math.round(minutes)} דקות — מדלג` };
    }
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
  // Files answered from the notebook rather than from Claude. Counted
  // separately because it is the whole point of the notebook, and because a
  // run that says "42 דולגו" tells nobody whether it cost anything.
  let cached = 0;
  // Files rejected locally, before any AI call — the cheapest possible answer.
  let prefiltered = 0;
  // Files that only ever reached the cheap gate model.
  let gated = 0;
  // Every API call this run, priced. The whole point of the two-stage split is
  // a number, and a number nobody can see is a number nobody can act on.
  const ledger = newLedger();
  // The hashes answered from the notebook this run — counted up at the end in
  // one write, so "how many times has this file come back" is a real number
  // without paying a write per file per run.
  const cachedHashes = [];
  const problems = [];

  for (const msg of fetched.messages) {
    for (const att of msg.attachments) {
      const hash = form101.hashFile(att.buffer);
      const seen = await alreadySeen(hash);
      if (seen.seen) {
        skipped += 1;
        if (seen.cached) { cached += 1; cachedHashes.push(hash); }
        continue;
      }

      /**
       * Try to reject it locally before paying for a look.
       *
       * Only ever says "no": a text-layer PDF with no "101" in it anywhere.
       * Anything it can't decide goes to the AI exactly as before.
       */
      const pre = await prefilter(att.buffer, att.contentType, att.filename);
      if (pre.decided && !pre.isForm101) {
        await remember(hash, 'not_form_101', att, pre.reason);
        prefiltered += 1;
        skipped += 1;
        continue;
      }

      const data = att.buffer.toString('base64');

      /**
       * Stage one — the cheap question, on the cheap model.
       *
       * Almost everything in a mailbox fails "is this a form 101 at all", and
       * that question does not need the model that reads a ת״ז off a scan. The
       * gate leans yes when unsure (see GATE_SYSTEM), and a gate that errors or
       * cannot answer returns null, which falls through to the full read — a
       * failed cheap check must never discard a file.
       */
      let gate = null;
      try {
        gate = await gateIsForm101(data, att.filename, att.contentType, {
          onUsage: (m, u) => ledger.add(m, u),
        });
        if (gate) gated += 1;
      } catch { /* gate unavailable — fall through to the full read */ }

      if (gate && !gate.is_form_101) {
        await remember(hash, 'not_form_101', att,
          `סינון מהיר (${gate.model}): אינו טופס 101 · ביטחון ${gate.confidence}`);
        skipped += 1;
        continue;
      }

      let scan;
      try {
        scan = await scanForm101(data, att.filename, att.contentType, {
          onUsage: (m, u) => ledger.add(m, u),
        });
        filesScanned += 1;
      } catch (err) {
        // A single unreadable attachment must not end the run — the next one
        // may be the form somebody is waiting on. Recorded so a file that
        // cannot be read is not paid for on every run forever; the attempt
        // counter lets a transient failure through a few more times.
        problems.push(`${att.filename}: ${err.message}`);
        await remember(hash, 'unreadable', att, err.message);
        skipped += 1;
        continue;
      }

      // The answer that used to be thrown away, and that every later run paid
      // to hear again.
      if (!scan.is_form_101) {
        await remember(hash, 'not_form_101', att, scan.notes || '');
        skipped += 1;
        continue;
      }

      const match = await form101.matchEmployee(scan, msg.from, { allowNameMatch: cfg.allow_name_match });

      if (match.employee) {
        // Already filed for that year — by hand, or from a different message.
        // Keep the first one; a second copy is noise in the employee's file.
        const exists = await EmployeeDocument.exists({
          employee_id: match.employee._id,
          doc_type: 'form_101',
          tax_year: scan.tax_year || form101.currentTaxYear(),
        });
        if (exists) {
          await remember(hash, 'already_filed', att,
            `${match.employee.full_name || ''} — כבר קיים טופס לשנת ${scan.tax_year || form101.currentTaxYear()}`);
          skipped += 1;
          continue;
        }

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

  if (cachedHashes.length) {
    await ScannedAttachment.updateMany(
      { hash: { $in: cachedHashes } },
      { $inc: { times_seen: 1 }, $set: { last_seen_at: new Date() } },
    );
  }

  const status = attached + unmatched === 0 ? 'empty' : 'ok';
  const parts = [];
  if (attached) parts.push(`${attached} שויכו`);
  if (gated) parts.push(`${gated} עברו סינון מהיר, ${filesScanned} נקראו במלואם`);
  // The cost, in the sentence a person actually reads.
  if (ledger.total > 0) parts.push(`עלות: $${ledger.total.toFixed(4)}`);
  if (unmatched) parts.push(`${unmatched} ממתינים לשיוך`);
  if (skipped) {
    const free = [];
    if (cached) free.push(`${cached} מהזיכרון`);
    if (prefiltered) free.push(`${prefiltered} נדחו מקומית`);
    parts.push(`${skipped} דולגו${free.length ? ` (${free.join(', ')} — ללא עלות)` : ''}`);
  }
  if (problems.length) parts.push(`שגיאות: ${problems.slice(0, 3).join('; ')}`);

  return record(cfg, {
    trigger,
    status,
    messages_scanned: fetched.messages.length,
    files_scanned: filesScanned,
    attached_count: attached,
    unmatched_count: unmatched,
    skipped_count: skipped,
    cached_count: cached,
    prefiltered_count: prefiltered,
    gated_count: gated,
    cost_usd: ledger.total,
    cost_breakdown: ledger.breakdown,
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

module.exports = { run, tick, getConfig, isRunning };
