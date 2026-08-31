const mongoose = require('mongoose');

/**
 * PunchEntryTask — "השלם את ההחתמות החסרות של הסניף שלך", assigned by
 * accounting to a branch's manager for one month.
 *
 * The reminder email/WhatsApp that preceded this left no trace: nobody could
 * tell whether a manager ever saw it, and nothing greeted them when they next
 * opened the app. This is the standing task behind that nudge — it survives the
 * message, it is what the manager's login gate reads, and it is what tells
 * accounting "sent / seen / done".
 *
 * `missing_snapshot` is what was outstanding AT ASSIGNMENT — kept for the audit
 * trail only. The live list is always recomputed from the punches themselves,
 * so a day completed by the employee from האזור שלי closes the task too.
 *
 * A task auto-completes the moment its branch has no missing day left for the
 * month; a manager may also close it explicitly with a note (a lone punch that
 * is simply wrong — the employee never worked that day — can never be "filled").
 */
const punchEntryTaskSchema = new mongoose.Schema({
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  month: { type: String, required: true, index: true },   // 'YYYY-MM'
  status: { type: String, enum: ['open', 'done', 'cancelled'], default: 'open', index: true },

  // What accounting asked for, frozen at assignment time.
  missing_snapshot: {
    type: [{
      employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
      full_name: String,
      date: String,        // 'YYYY-MM-DD'
      punch_hhmm: String,  // the lone punch that day
    }],
    default: [],
  },
  missing_count_at_assign: { type: Number, default: 0 },
  duplicates_count_at_assign: { type: Number, default: 0 },

  assigned_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  assigned_at: { type: Date, default: Date.now },
  // Addressed to these logins — a branch can have more than one manager.
  manager_user_ids: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  emailed: { type: Number, default: 0 },       // how many real inboxes were mailed
  reminder_count: { type: Number, default: 1 }, // re-sending bumps this, not a new row

  // Read receipts — the honest answer to "did they even see it?".
  first_seen_at: { type: Date, default: null },
  last_seen_at: { type: Date, default: null },
  seen_count: { type: Number, default: 0 },
  seen_by: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

  completed_at: { type: Date, default: null },
  completed_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  completed_note: { type: String, default: '' },
  auto_completed: { type: Boolean, default: false },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

// One live task per branch per month — re-sending refreshes the existing row.
punchEntryTaskSchema.index(
  { branch_id: 1, month: 1 },
  { unique: true, partialFilterExpression: { status: 'open' } },
);

// The task board pulls incrementally with find({updated_at: {$gt: since}})
// sorted by updated_at. WITHOUT this index Mongo sorts the whole collection in
// memory and refuses past 32MB — which is what broke the mirror on its first
// run, when `since` is epoch 0 and the filter matches everything.
//
// An index rather than allowDiskUse: disk sorting would have made a bad query
// merely possible, where this makes it cheap forever.
punchEntryTaskSchema.index({ updated_at: 1 });

module.exports = mongoose.model('PunchEntryTask', punchEntryTaskSchema);
