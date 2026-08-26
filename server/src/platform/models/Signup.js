const mongoose = require('mongoose');

/**
 * Signup — a gan owner who filled in the form on the marketing page.
 *
 * Not `Lead`. That one is a PARENT asking about a place for their child, and it
 * lives inside a customer's own database. This is somebody asking to BECOME a
 * customer, so it belongs on the control plane, next to the customers it turns
 * into — and it must be readable before any customer database exists for them.
 *
 * The row is written before the notification email is attempted, and the
 * attempt's outcome is stored on it. A lead that exists only in an email is
 * lost the day the mail provider is misconfigured, and the first anybody knows
 * is the person who paid 500 ₪ and never got a call.
 */
const signupSchema = new mongoose.Schema({
  gan_name:  { type: String, required: true, trim: true, maxlength: 120 },
  full_name: { type: String, required: true, trim: true, maxlength: 120 },
  phone:     { type: String, required: true, trim: true, maxlength: 40, index: true },
  email:     { type: String, required: true, trim: true, lowercase: true, maxlength: 160, index: true },
  children:  { type: Number, min: 1, max: 100000, default: null },
  branches:  { type: String, default: '', maxlength: 20 },   // '1' | '2–5' | '6–20' | '21+'
  note:      { type: String, default: '', maxlength: 2000 },

  // Where they came from, for working out which channel is worth anything.
  source:    { type: String, default: '', maxlength: 200 },  // utm / campaign / 'conference'
  referrer:  { type: String, default: '', maxlength: 400 },
  user_agent:{ type: String, default: '', maxlength: 400 },

  status: {
    type: String,
    enum: ['new', 'contacted', 'paid', 'declined'],
    default: 'new',
    index: true,
  },
  note_internal: { type: String, default: '', maxlength: 2000 },

  // Once they become a customer, the tenant they turned into.
  tenant_id: { type: mongoose.Schema.Types.ObjectId, default: null },

  // The notification attempt. `notify_error` non-empty means the row is here
  // and nobody was told — which is the case the console has to show loudly.
  notified_at:   { type: Date, default: null },
  notify_error:  { type: String, default: '' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

signupSchema.index({ status: 1, created_at: -1 });

module.exports = signupSchema;
