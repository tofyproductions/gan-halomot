const mongoose = require('mongoose');

/**
 * Every file the AI has already looked at — including the ones it rejected.
 *
 * The mail scan already refused to re-send a file it had FILED: the hash of an
 * attached form lives on the EmployeeDocument, and the hash of one waiting to
 * be matched lives on the Form101Inbox row. But a file the AI examined and
 * turned down — a payslip, a signature page, a company logo in the footer —
 * was recorded nowhere. So every scan sent it to Claude again, got the same
 * "this is not a form 101" back, and paid for it again. With a thirty-day
 * lookback and a scan every six hours, one payslip in the mailbox is four
 * paid answers a day, forever, all identical.
 *
 * This is the notebook: the verdict, kept by content hash, so the second time
 * a file appears the answer is a local lookup instead of a request.
 *
 * `unreadable` is the one verdict that is not final. A file can fail to parse
 * because the model was briefly unavailable, not because the file is bad, so
 * it is retried — but only a few times, because a genuinely corrupt PDF must
 * not be paid for on every run either.
 */

const VERDICTS = [
  'not_form_101',   // the AI read it and it is not a form
  'already_filed',  // a form, but this employee already has one for that year
  'unreadable',     // the scan itself failed — retried a limited number of times
];

/** How many times an unreadable file is tried again before it is left alone. */
const MAX_ATTEMPTS = 3;

const scannedAttachmentSchema = new mongoose.Schema({
  // sha256 of the file's bytes — the same key EmployeeDocument.mail.hash and
  // Form101Inbox.hash use, so the three together are one lookup space.
  hash: { type: String, required: true, unique: true, index: true },

  verdict: { type: String, enum: VERDICTS, required: true, index: true },

  // Which scan produced the verdict. The sick-note scan reads the same mailbox
  // and pays the same way; it can share this table without the two confusing
  // each other's answers.
  source: { type: String, default: 'form101', index: true },

  file_name: { type: String, default: '' },
  mimetype: { type: String, default: '' },
  size: { type: Number, default: null },

  // Why, in words, for the run that has to explain itself to a person.
  note: { type: String, default: '' },

  // How many times this file has turned up again since. The saving, counted.
  times_seen: { type: Number, default: 1 },
  attempts: { type: Number, default: 1 },

  first_seen_at: { type: Date, default: Date.now },
  last_seen_at: { type: Date, default: Date.now },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

scannedAttachmentSchema.statics.VERDICTS = VERDICTS;
scannedAttachmentSchema.statics.MAX_ATTEMPTS = MAX_ATTEMPTS;

module.exports = mongoose.model('ScannedAttachment', scannedAttachmentSchema);
