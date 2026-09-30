const mongoose = require('mongoose');

/**
 * What the import bot did, every time it knocked.
 *
 * The bot exists because neither Cibus nor ClickTac has an API: their reports
 * can only be taken off their own websites, and Cibus mails its file on the
 * 2nd although the site has it on the 1st at 00:01. So something signs in,
 * downloads, and posts the file here — see routes/importBot.routes.js.
 *
 * WHY A LOG AND NOT JUST THE IMPORT ITSELF. A robot that stops working stops
 * quietly. Nobody notices an upload that never arrived; they notice a payroll
 * that is wrong, a month later. Cibus already learned this the hard way and
 * keeps its own run log for exactly this reason (models/CibusSync.js), and the
 * same failure is available to every future bot route, so the record is kept
 * here for all of them — refusals included. A rejected attempt is the most
 * informative row in this collection: it is the bot telling us it tried.
 *
 * WHAT IS DELIBERATELY NOT HERE: anybody's name, ת"ז or salary. The bot is
 * handed a file and told a count back, and the log holds the same counts. A
 * third party's robot has no reason to hold a child's name, and neither does
 * the record of its visit.
 */
const importBotRunSchema = new mongoose.Schema({
  at: { type: Date, default: Date.now, index: true },

  // Which door was knocked on: 'cibus' | 'clicktac'.
  kind: { type: String, required: true, index: true },

  /**
   * 'ok'       — the file was parsed and written
   * 'rejected' — we refused it, and `message` says why (no branch, a month
   *              already imported, a file neither export recognises). The bot
   *              did its job; the request was wrong.
   * 'error'    — something broke on our side.
   */
  status: { type: String, enum: ['ok', 'rejected', 'error'], required: true },

  file_name: { type: String, default: '' },
  file_bytes: { type: Number, default: 0 },

  // Cibus: the payroll month written into. ClickTac: nothing.
  month: { type: String, default: '' },
  // ClickTac: which branch the caller named. Never guessed from the file —
  // see the branch note in controllers/externalEnrollment.controller.js.
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
  branch_name: { type: String, default: '' },
  academic_year: { type: String, default: '' },

  // Counts only, matching what the bot is told back.
  counts: {
    matched: { type: Number, default: 0 },
    unmatched: { type: Number, default: 0 },
    created: { type: Number, default: 0 },
    updated: { type: Number, default: 0 },
    unchanged: { type: Number, default: 0 },
  },

  // The undo handle, so the office can reverse one upload without hunting for
  // it: DELETE /api/external-enrollments/imports/:id.
  enrollment_import_id: { type: mongoose.Schema.Types.ObjectId, ref: 'EnrollmentImport', default: null },

  message: { type: String, default: '' },
  // Which address it came from, for the day a secret leaks and we need to know
  // whether anybody else used it.
  ip: { type: String, default: '' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

module.exports = mongoose.model('ImportBotRun', importBotRunSchema);
