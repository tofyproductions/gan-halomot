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

  /**
   * The gan year this registration is FOR — "YYYY-YYYY".
   *
   * Until now the year was inferred from start_date, in three different ways:
   * the registration page took start_date inside Sep–Aug, collections took any
   * registration whose date range *overlapped* the year, and Child carried its
   * own academic_year string copied at creation. Three derivations of one fact
   * that nothing kept in agreement — so a registration typed with the wrong
   * start date could not be moved to the year it belonged to, and one that
   * spanned two years appeared twice in collections.
   *
   * The year is a decision, not a consequence of a date, so it is stored. The
   * dates still say when the child actually starts and stops (a mid-year join
   * is prorated from start_date), but they no longer decide which year the
   * registration is filed under.
   */
  academic_year: { type: String, default: null },
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
registrationSchema.index({ academic_year: 1 });
// Deliberately NOT unique. Two registrations for the same child in one year is
// always a mistake, but the names are typed by hand — "מור קיסר" and
// "מור אור קיסר" are the same parent — so a unique index would reject good data
// while missing the duplicates that matter. The check is done in code, where it
// can normalise the name, explain itself, and be overridden.
registrationSchema.index({ child_name: 1, academic_year: 1 });

module.exports = mongoose.model('Registration', registrationSchema);
