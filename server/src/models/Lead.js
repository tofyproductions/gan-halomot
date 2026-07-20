const mongoose = require('mongoose');

/**
 * Lead — a new-parent inquiry submitted from a public marketing page (linked in
 * paid ads). No login: the parent fills a short form, and it lands in the
 * manager's leads page where they can call / WhatsApp / edit / track status
 * (and later convert to a Registration + contract).
 *
 * Branch: either preset (a per-branch link /lead/:branchId) or chosen by the
 * parent from the general link. It may be null ("not sure yet") — then the
 * office/admins handle assignment.
 */
const leadSchema = new mongoose.Schema({
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
  parent_name: { type: String, required: true },
  parent_phone: { type: String, required: true },
  parent_email: { type: String, default: '' },
  child_name: { type: String, default: '' },
  child_birth_date: { type: String, default: '' },   // 'YYYY-MM' or 'YYYY-MM-DD' (free)
  message: { type: String, default: '' },            // free text from the parent
  source: { type: String, default: '' },             // ad/campaign source (utm etc.)
  // Pipeline status the manager advances.
  status: {
    type: String,
    enum: ['new', 'contacted', 'tour_scheduled', 'converted', 'closed'],
    default: 'new',
    index: true,
  },
  manager_note: { type: String, default: '' },       // internal follow-up notes
  handled_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  // Once converted to a registration, link it so we don't double-handle.
  registration_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Registration', default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

leadSchema.index({ branch_id: 1, status: 1, created_at: -1 });

module.exports = mongoose.model('Lead', leadSchema);
