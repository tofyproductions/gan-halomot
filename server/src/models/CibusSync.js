const mongoose = require('mongoose');

/**
 * Configuration and run history for the automatic Cibus import.
 *
 * A single document (`key: 'cibus'`). It holds the MATCHING RULES — which
 * sender, which subject — and the log of what happened. It deliberately holds
 * no credentials: those are environment variables, because a mail password
 * that can be read back out of the admin screen leaks with the admin screen.
 *
 * The run log exists because the failure mode of any scheduled import is
 * SILENCE. A month where nothing arrived looks exactly like a month where
 * everyone happened to spend nothing, and by the time anyone notices, three
 * payrolls have gone out wrong. Every attempt is recorded, successful or not,
 * and `last_success_at` is what the staleness alert reads.
 */
const runSchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  month: { type: String, default: '' },          // 'YYYY-MM' the report was written into
  status: { type: String, enum: ['ok', 'empty', 'error'], default: 'ok' },
  /**
   * 'schedule' the nightly mailbox job, 'manual' a person in the payroll
   * screen, 'bot' the import bot posting a file it took off the Cibus site
   * (routes/importBot.routes.js).
   *
   * A bot import MUST land here and not only in its own log. This document is
   * what `tick()` reads to decide the month is already done, and what
   * `alertIfStale` reads to decide nothing has arrived — so a bot success that
   * did not update it would re-import the same month off the email on the 2nd
   * and, forty days on, mail the office that the import has been failing.
   */
  trigger: { type: String, enum: ['schedule', 'manual', 'bot'], default: 'schedule' },
  matched_count: { type: Number, default: 0 },
  unmatched_count: { type: Number, default: 0 },
  total_amount: { type: Number, default: 0 },
  file_name: { type: String, default: '' },
  mail_subject: { type: String, default: '' },
  mail_from: { type: String, default: '' },
  mail_date: { type: Date, default: null },
  // Names in the report with no employee behind them — the accountant has to
  // see these, they are money nobody was charged for.
  unmatched: { type: [{ name: String, id: String, amount: Number, _id: false }], default: [] },
  message: { type: String, default: '' },
}, { _id: true });

const cibusSyncSchema = new mongoose.Schema({
  key: { type: String, default: 'cibus', unique: true },

  enabled: { type: Boolean, default: false },
  // Any-of substring matches, case-insensitive, on sender and subject.
  from_contains: { type: [String], default: ['pluxee', 'cibus', 'sodexo'] },
  subject_contains: { type: [String], default: [] },
  mailbox: { type: String, default: 'INBOX' },
  mark_seen: { type: Boolean, default: true },

  // The report for month N arrives at the start of month N+1, so by default it
  // is written into the PREVIOUS month. Set to 0 to write into the current one.
  month_offset: { type: Number, default: -1 },
  // Day of month the job starts looking. It runs daily from then until it
  // succeeds for that month, so one late email doesn't skip the month.
  run_from_day: { type: Number, default: 2 },

  last_run_at: { type: Date, default: null },
  last_success_at: { type: Date, default: null },
  last_success_month: { type: String, default: '' },
  last_error: { type: String, default: '' },
  stale_alerted_at: { type: Date, default: null },
  runs: { type: [runSchema], default: [] },     // newest first, capped
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

module.exports = mongoose.model('CibusSync', cibusSyncSchema);
