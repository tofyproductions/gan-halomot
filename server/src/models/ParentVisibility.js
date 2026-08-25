const mongoose = require('mongoose');

/**
 * מה ההורים רואים השבוע — one switch per branch per week.
 *
 * WHY A WEEK. The gan plans a week at a time and publishes it when it is
 * ready. A month is too coarse (the last week is still being written when the
 * first is done) and a day is too fine (nobody wants to press a button every
 * morning). The gan asked for a week, and a week is also what the gantt itself
 * is built out of.
 *
 * WHY THE DEFAULTS DIFFER, and this is the part that matters:
 *
 *   gantt — default OFF. Parents have never seen it. Switching it on for every
 *           branch at once would publish plans that were written on the
 *           assumption nobody outside the room reads them.
 *
 *   menu  — default ON. Parents ALREADY see the day's dishes inside the daily
 *           board. Defaulting this off would silently take away something they
 *           have today, which is a worse failure than never having had it: the
 *           gan would not know it had happened and the family would think the
 *           kitchen stopped answering.
 *
 * So a missing row means "gantt hidden, menu shown", and both switches are
 * written only when somebody actually decides.
 */
const parentVisibilitySchema = new mongoose.Schema({
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  // ISO week, 'YYYY-Www' — '2026-W38'. A string because it is a label, and
  // because the alternative (a start date) invites two callers to disagree
  // about whether a week starts on Sunday.
  week: { type: String, required: true, index: true },

  gantt: { type: Boolean, default: false },
  menu: { type: Boolean, default: true },

  set_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  set_by_name: { type: String, default: '' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

parentVisibilitySchema.index({ branch_id: 1, week: 1 }, { unique: true });

module.exports = mongoose.model('ParentVisibility', parentVisibilitySchema);
