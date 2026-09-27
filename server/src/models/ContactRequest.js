const mongoose = require('mongoose');

/**
 * "פניות למשרד" — a staff member's question or request to the office, and the
 * conversation that follows (docs/superpowers/specs/2026-09-27-email-routing-and-contact-design.md).
 *
 * The topic decides who in the office sees it: the contact_* topics of the
 * office routing (Setting email_routing, services/office-recipients.service).
 *
 * status: open = waiting for the office · answered = the office replied last ·
 * closed = done (either side may close; a closed thread takes no replies).
 */
const attachmentSchema = new mongoose.Schema({
  storage_key: { type: String, default: null },  // in the bucket when one is configured
  data: { type: String, default: null },         // base64 fallback when not
  content_type: { type: String, default: '' },
  name: { type: String, default: '' },
}, { _id: false });

const messageSchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  by_name: { type: String, default: '' },
  from_office: { type: Boolean, default: false },
  text: { type: String, default: '' },
  attachment: { type: attachmentSchema, default: null },
}, { _id: false });

const contactRequestSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  user_name: { type: String, default: '' },
  employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
  topic: {
    type: String,
    enum: ['contact_tech', 'contact_graphics', 'contact_payroll', 'contact_general'],
    required: true,
  },
  status: { type: String, enum: ['open', 'answered', 'closed'], default: 'open' },
  messages: { type: [messageSchema], default: [] },
  last_message_at: { type: Date, default: Date.now },
  closed_at: { type: Date, default: null },
  closed_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

contactRequestSchema.index({ user_id: 1, last_message_at: -1 });
contactRequestSchema.index({ topic: 1, status: 1, last_message_at: -1 });

module.exports = mongoose.model('ContactRequest', contactRequestSchema);
