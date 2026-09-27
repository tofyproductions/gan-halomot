const mongoose = require('mongoose');

/**
 * What the accountant ALREADY HAS in שקלולית, per employee — the master-file
 * row exactly as it was last downloaded from the ייצוא לשקלולית dialog.
 *
 * The employee master is not a monthly file: the accountant keys a person
 * once, and re-keying seventy unchanged rows every month is how the one real
 * change gets missed. So each master download records what it contained, and
 * the next export diffs the live cards against this collection — new people
 * and changed fields are called out by name, and "no changes" is an answer
 * the dialog can actually give.
 */
const shkulitEmployeeSnapshotSchema = new mongoose.Schema({
  employee_number: { type: String, required: true, unique: true, index: true },
  /** The master row's named fields at last download (column → value). */
  data: { type: mongoose.Schema.Types.Mixed, default: {} },
  last_exported_at: { type: Date, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

module.exports = mongoose.model('ShkulitEmployeeSnapshot', shkulitEmployeeSnapshotSchema);
