const mongoose = require('mongoose');

/**
 * A registration that happened somewhere else.
 *
 * Three of the network's branches sit under רשת מעונות אמונה, and their
 * enrollment runs in קליקטאק — an external system this one does not control.
 * Only כפר סבא - קפלן registers here, which is why it is the only branch with
 * a collections flow of its own. For the other three, the families exist, the
 * contracts are signed, the standing orders are set up, and none of it is
 * visible in this system at all.
 *
 * A ClickTac export lands HERE first, not in Registration. Seventy-six
 * children arriving in one spreadsheet is not something to write blind into
 * the live tables: the file decides nothing on its own, it is reviewed, and
 * only what is approved becomes a registration. The raw row is kept alongside
 * the parsed fields, because when a mapping turns out to be wrong the answer
 * has to be re-derivable without asking anyone to export again.
 *
 * `content_hash` covers the parsed payload, so re-importing an unchanged file
 * is a no-op and a changed row is visible as a change rather than as a second
 * record.
 */

const partySchema = new mongoose.Schema({
  first_name: { type: String, default: '' },
  last_name: { type: String, default: '' },
  id_number: { type: String, default: '' },
  // אם / אב / הורה — ClickTac asks, and it is the only thing that says which
  // of the two registrants is the mother and which the father.
  relation: { type: String, default: '' },
  marital_status: { type: String, default: '' },
  address: { type: String, default: '' },
  phone: { type: String, default: '' },
  email: { type: String, default: '' },
  occupation: { type: String, default: '' },
  is_self_employed: { type: Boolean, default: null },
}, { _id: false });

const externalEnrollmentSchema = new mongoose.Schema({
  source: { type: String, default: 'clicktac', index: true },
  source_file: { type: String, default: '' },
  imported_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  /**
   * The branch, supplied at import — never read from the file.
   *
   * `מוסד` says "כפר סבא" on every row, and there are TWO branches in Kfar
   * Saba (משה דיין, קפלן). The column cannot tell them apart, and the street
   * addresses in the rows are streets, not branches. Guessing here would file
   * a whole cohort under the wrong gan.
   */
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  academic_year: { type: String, required: true, index: true },

  child: {
    first_name: { type: String, default: '' },
    last_name: { type: String, default: '' },
    full_name: { type: String, default: '' },
    // ת.ז הנרשם — unique in every export seen so far, and the merge key.
    id_number: { type: String, default: '', index: true },
    birth_date: { type: Date, default: null },
    gender: { type: String, default: '' },
    // ClickTac's own layer: תינוק / פעוט / בוגר.
    age_group: { type: String, default: '' },
    health_fund: { type: String, default: '' },
    has_allergy: { type: Boolean, default: false },
    allergy_detail: { type: String, default: '' },
    // מלווה — a one-to-one aide, for the few children who have one.
    aide_name: { type: String, default: '' },
    aide_phone: { type: String, default: '' },
    welfare_referred: { type: Boolean, default: false },
  },

  parent1: { type: partySchema, default: () => ({}) },
  parent2: { type: partySchema, default: () => ({}) },

  enrollment: {
    status: { type: String, default: '' },          // התקבל / ביטל רישום
    continuing: { type: Boolean, default: false },  // ממשיך
    second_signer: { type: String, default: '' },   // נחתם / ממתין לחתימה / לא נדרש
    registered_at: { type: Date, default: null },
    portal: { type: String, default: '' },
    receipt_number: { type: String, default: '' },
    registration_fee_method: { type: String, default: '' },
    registration_fee_card_last4: { type: String, default: '' },
    tuition_method: { type: String, default: '' },
    tuition_card_last4: { type: String, default: '' },
    voucher_number: { type: String, default: '' },
    amount: { type: Number, default: 0 },
  },

  // הוראת קבע. Kept whole at the user's instruction — the network may bill
  // these families through this system later, and a standing order without an
  // account number cannot be acted on. Never included in list responses; the
  // review screen fetches one record at a time.
  standing_order: {
    bank: { type: String, default: '' },
    branch: { type: String, default: '' },
    account: { type: String, default: '' },
    holder_name: { type: String, default: '' },
  },

  /**
   * The age group this system computes, at 1 September of the gan year.
   *
   * Shown NEXT TO ClickTac's own שכבת גיל rather than replacing it. Where the
   * two disagree, the disagreement is the finding — a child on the boundary
   * has been placed by someone, and knowing that is worth more than a number
   * that always agrees with itself.
   */
  computed: {
    age_months: { type: Number, default: null },
    age_group: { type: String, default: '' },
    agrees_with_source: { type: Boolean, default: null },
  },

  review: {
    status: {
      type: String,
      enum: ['pending', 'imported', 'ignored'],
      default: 'pending',
      index: true,
    },
    // How the row was tied to something already here, if it was.
    matched_registration_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Registration', default: null },
    matched_by: { type: String, default: '' },      // 'id_number' | 'name_birth' | 'phone'
    imported_registration_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Registration', default: null },
    imported_at: { type: Date, default: null },
    note: { type: String, default: '' },
  },

  // The row exactly as it came out of ClickTac, so a wrong mapping is a
  // re-parse rather than a re-export.
  raw: { type: mongoose.Schema.Types.Mixed, default: {} },
  content_hash: { type: String, required: true, index: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

// One row per child per year per source. A re-import updates in place.
externalEnrollmentSchema.index(
  { source: 1, academic_year: 1, 'child.id_number': 1 },
  { unique: true },
);
externalEnrollmentSchema.index({ branch_id: 1, 'review.status': 1 });

module.exports = mongoose.model('ExternalEnrollment', externalEnrollmentSchema);
