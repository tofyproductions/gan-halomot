const mongoose = require('mongoose');

/**
 * Configuration and run history for the automatic טופס 101 mail scan.
 *
 * A single document (`key: 'form101'`). Same shape and same reasoning as
 * CibusSync: the MATCHING RULES live here so they can be corrected without a
 * deploy — and the first run is where you find out what the mail actually
 * looks like — while the mailbox CREDENTIALS stay in the environment, because
 * a mail password that can be read back out of the admin screen leaks with the
 * admin screen.
 *
 * It reads the same mailbox as the Cibus import (CIBUS_MAIL_USER /
 * CIBUS_MAIL_PASS), which is why there are no credentials of its own.
 *
 * The run log exists for the same reason it exists there: the failure mode of
 * a scheduled import is SILENCE. A week where no form arrived looks exactly
 * like a week where the scan was quietly broken, and nobody finds out until a
 * payroll is run with the wrong tax deduction.
 */
const runSchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  status: { type: String, enum: ['ok', 'empty', 'error'], default: 'ok' },
  trigger: { type: String, enum: ['schedule', 'manual'], default: 'schedule' },
  messages_scanned: { type: Number, default: 0 },
  files_scanned: { type: Number, default: 0 },
  attached_count: { type: Number, default: 0 },   // matched to an employee
  unmatched_count: { type: Number, default: 0 },  // went to the review queue
  skipped_count: { type: Number, default: 0 },    // already imported, or not a 101
  // Of the skipped, how many were answered from ScannedAttachment instead of
  // from Claude. The AI calls a run actually paid for are files_scanned; this
  // is the number it did not.
  cached_count: { type: Number, default: 0 },
  // Of the skipped, how many were rejected locally by reading the PDF's own
  // text layer — never sent to Claude even once.
  prefiltered_count: { type: Number, default: 0 },
  message: { type: String, default: '' },
}, { _id: true });

const form101SyncSchema = new mongoose.Schema({
  key: { type: String, default: 'form101', unique: true },

  enabled: { type: Boolean, default: false },
  // Any-of substring matches, case-insensitive. Empty = don't filter on it.
  // Sender is deliberately empty by default: forms arrive from the employees
  // themselves, so there is no one address to key on.
  from_contains: { type: [String], default: [] },
  subject_contains: { type: [String], default: ['101', 'טופס'] },
  mailbox: { type: String, default: 'INBOX' },
  // Off by default — this mailbox is shared with the Cibus import, and marking
  // mail read on someone else's behalf is not this job's call to make.
  mark_seen: { type: Boolean, default: false },
  // How far back each scan looks. Attachments are deduped by content hash, so
  // re-reading the same window is harmless.
  lookback_days: { type: Number, default: 30 },
  max_messages: { type: Number, default: 40 },

  // A name-only match is a guess that happened to be unique. On by default —
  // most employees send the form from a personal address the system has never
  // seen, so the name on the form is all there is. Turn it off to require an
  // identity match (ת״ז or a known sender address) and send the rest to review.
  allow_name_match: { type: Boolean, default: true },

  /**
   * Don't re-scan the whole window just because the server restarted.
   *
   * The scan is kicked off four minutes after every boot, and Render boots on
   * every deploy — so ten deploys in a day were ten full thirty-day scans. A
   * scheduled run inside this window is skipped; pressing "סרוק עכשיו" is
   * never throttled, because a person pressing it is asking for exactly that.
   */
  min_interval_minutes: { type: Number, default: 60 },

  last_run_at: { type: Date, default: null },
  last_success_at: { type: Date, default: null },
  last_error: { type: String, default: '' },
  runs: { type: [runSchema], default: [] },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

module.exports = mongoose.model('Form101Sync', form101SyncSchema);
