const mongoose = require('mongoose');

/**
 * רישום עובד/ת חדש/ה — what somebody who was hired fills in about themselves,
 * BEFORE they are anybody in this system.
 *
 * The office used to collect this on paper or over WhatsApp: a ת"ז photo, a
 * bank form, a certificate, an address, and a phone number for whoever to call
 * if something happens on a shift. Every one of those arrived separately, in a
 * different thread, and was typed into the employee card by hand — which is
 * why half the cards have no birth date and a third have no bank details until
 * the first payroll run discovers it.
 *
 * NOBODY HERE IS AN EMPLOYEE. The link is permanent and copied into WhatsApp,
 * so it will end up forwarded; anything reachable that way must not be able to
 * create staff. A submission lands here as a row waiting for a human, and only
 * an accountant or an admin turns it into an Employee — at which point the
 * files move into that employee's תיק and this row keeps only the fact that it
 * happened.
 *
 * BANK DETAILS ARE NOT FOR EVERYONE. A branch manager reviews the person she
 * hired; she has no reason to read their account number, and the controller
 * strips it for anybody who is not accounting. Kept on the row rather than
 * written straight onto a card so there is one place to guard.
 */

/** One uploaded file. Same two-way storage split as everything else. */
const fileSchema = new mongoose.Schema({
  kind: {
    type: String,
    enum: ['id_document', 'bank_details', 'certificate', 'other'],
    default: 'other',
  },
  storage_key: { type: String, default: null },
  data: { type: String, default: null },        // base64 fallback, no data: prefix
  filename: { type: String, default: '' },
  mimetype: { type: String, default: '' },
  size_bytes: { type: Number, default: 0 },
}, { _id: true });

const STATUSES = ['pending', 'approved', 'rejected'];

const employeeOnboardingSchema = new mongoose.Schema({
  // --- who they say they are --------------------------------------------
  full_name: { type: String, required: true, trim: true },
  /** Digits only. The one field that decides whether this is a person we
   *  already have, so it is normalised on the way in like Candidate.phone. */
  israeli_id: { type: String, default: '', index: true, trim: true },
  phone: { type: String, default: '' },
  email: { type: String, default: '' },
  address: { type: String, default: '' },
  birth_date: { type: String, default: '' },   // 'YYYY-MM-DD', as typed

  /** The branch label they picked, resolved to a real branch where possible. */
  requested_branch: { type: String, default: '' },
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
  position: { type: String, default: '' },

  // --- payroll ----------------------------------------------------------
  bank_number: { type: String, default: '' },
  bank_branch: { type: String, default: '' },
  bank_account: { type: String, default: '' },
  bank_account_holder: { type: String, default: '' },

  // --- who to ring ------------------------------------------------------
  emergency_name: { type: String, default: '' },
  emergency_phone: { type: String, default: '' },
  emergency_relation: { type: String, default: '' },

  note: { type: String, default: '' },
  files: { type: [fileSchema], default: [] },

  // --- what happened to it ----------------------------------------------
  status: { type: String, enum: STATUSES, default: 'pending', index: true },
  /** Set once approved — the card this row became. */
  employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
  decided_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  decided_by_name: { type: String, default: '' },
  decided_at: { type: Date, default: null },
  /** Why it was refused. Required by the screen, not by the schema. */
  reject_reason: { type: String, default: '' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

employeeOnboardingSchema.statics.STATUSES = STATUSES;

/** The review queue's one query: what is still waiting, oldest first. */
employeeOnboardingSchema.index({ status: 1, created_at: 1 });

module.exports = mongoose.model('EmployeeOnboarding', employeeOnboardingSchema);
