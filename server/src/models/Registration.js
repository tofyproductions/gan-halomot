const mongoose = require('mongoose');

const registrationSchema = new mongoose.Schema({
  unique_id: { type: String, required: true, unique: true },
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
  child_name: { type: String, required: true },
  child_birth_date: { type: Date, default: null },
  classroom_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Classroom', default: null },
  parent_name: { type: String, required: true },
  parent_id_number: { type: String, default: null },
  parent_phone: { type: String, default: null },
  parent_email: { type: String, default: null },
  monthly_fee: { type: Number, required: true },
  fee_effective_from: { type: String, default: null },    // YYYY-MM: new fee applies from this month
  previous_monthly_fee: { type: Number, default: null },  // the old fee before the change
  registration_fee: { type: Number, default: 0 },
  start_date: { type: Date, required: true },
  end_date: { type: Date, required: true },
  status: {
    type: String,
    enum: ['link_generated', 'contract_signed', 'docs_uploaded', 'completed'],
    default: 'link_generated',
  },
  agreement_signed: { type: Boolean, default: false },
  card_completed: { type: Boolean, default: false },
  signature_data: { type: String, default: null },
  contract_pdf_path: { type: String, default: null },
  access_token: { type: String, default: null },
  token_expires_at: { type: Date, default: null },
  configuration: { type: mongoose.Schema.Types.Mixed, default: {} },

  /**
   * The registration this one renews.
   *
   * A registration covers ONE year — start_date to end_date — and a contract
   * is signed against it. When the year turns, the family needs a new
   * registration and a new signature; until they sign, the child is simply not
   * in next year's system, even if the parent already paid the registration
   * fee. This links the new year back to the old one so the renewal is
   * traceable, and so the same family is not issued two.
   */
  renewed_from: { type: mongoose.Schema.Types.ObjectId, ref: 'Registration', default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

registrationSchema.index({ access_token: 1 });
registrationSchema.index({ status: 1 });

module.exports = mongoose.model('Registration', registrationSchema);
