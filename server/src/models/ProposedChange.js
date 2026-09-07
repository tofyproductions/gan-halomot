const mongoose = require('mongoose');

/**
 * A write a viewer ("מנהל מערכת - לצפייה בלבד") asked for and may not make.
 *
 * The request is kept whole — method, path, body, the host it came to — so
 * that approving it means re-issuing it as the approver, through the same
 * route and the same validation the approver would hit typing it herself.
 * `summary` is what the approver reads on the card; it is derived at save
 * time from the body, because the body is JSON and the approver is a person.
 *
 * `status: failed` is a proposal that was approved and whose replay did not
 * return 2xx. It stays on the screen with the error so it can be retried or
 * rejected; it is never silently dropped.
 */
const summaryRowSchema = new mongoose.Schema({
  key: { type: String, default: '' },
  label: { type: String, default: '' },
  value: { type: String, default: '' },
}, { _id: false });

const proposedChangeSchema = new mongoose.Schema({
  requested_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  requested_by_name: { type: String, default: '' },
  requested_role: { type: String, default: '' },

  method: { type: String, required: true },
  path: { type: String, required: true },      // originalUrl, query included
  host: { type: String, default: '' },
  body: { type: mongoose.Schema.Types.Mixed, default: null },
  content_type: { type: String, default: 'application/json' },

  screen_label: { type: String, default: '' },
  summary: { type: [summaryRowSchema], default: [] },
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
  branch_name: { type: String, default: '' },

  approver: { type: String, enum: ['accountant', 'system_admin'], default: 'system_admin' },
  // `applying` is the claim: one approver took the row and the replay is in
  // flight. It exists so a second approve finds nothing to claim instead of
  // sending the same write twice.
  status: {
    type: String,
    enum: ['pending', 'applying', 'approved', 'rejected', 'failed'],
    default: 'pending',
    index: true,
  },
  decided_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  decided_by_name: { type: String, default: '' },
  decided_at: { type: Date, default: null },
  decision_note: { type: String, default: '' },
  apply_status: { type: Number, default: null },
  apply_error: { type: String, default: '' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

proposedChangeSchema.index({ status: 1, created_at: -1 });
proposedChangeSchema.index({ requested_by: 1, created_at: -1 });

module.exports = mongoose.model('ProposedChange', proposedChangeSchema);
