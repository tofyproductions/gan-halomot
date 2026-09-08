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

/**
 * An alert about how (or whether) the family pays — see services/paymentCheck.
 *
 * A sub-schema rather than a loose Mixed, so a code nobody defined cannot be
 * written into it by a future caller and then quietly counted.
 */
const paymentAlertSchema = new mongoose.Schema({
  code: { type: String, enum: ['cash', 'missing', 'incomplete', 'cheque'], required: true },
  label: { type: String, default: '' },
  /**
   * `error` stops the money — cash, no method, a הו"ק with no bank behind it.
   * `warning` is the one the owner asked for by name: a cheque is accepted,
   * the gan would simply rather have a standing order. Counting the two in one
   * number would put families nobody has to call onto the chase list, so the
   * severity is stored rather than inferred from the code by every reader.
   */
  severity: { type: String, enum: ['error', 'warning'], default: 'error' },
}, { _id: false });

/**
 * What ClickTac's CONTRACTS export knows and its registrations export does not.
 *
 * The two downloads are disjoint on purpose: the registrations export is the
 * family (both parents, phones, payment method, bank), and this one is the
 * agreement (the class the child was put in, the funding type, the subsidy
 * tier the whole fee hangs on, and the contract's dates). Neither is the whole
 * child, so both merge into one row and this sub-document is the half that
 * only the second file can fill.
 *
 * `institution` is the vendor's מעון and is NOT the branch — "כפר סבא" answers
 * for two gans, exactly as `מוסד` does in the other file. The branch is still
 * chosen at upload.
 *
 * `tuition_type` is a funding ARRANGEMENT ("מימון משרד הכלכלה"), never an
 * amount, and `tier` is a string because 0 is a real דרגה and coercing a blank
 * cell to a number would file every child in the export under it.
 */
const contractSchema = new mongoose.Schema({
  clicktac_id: { type: String, default: '' },
  status: { type: String, default: '' },            // התקבל / …
  registered_at: { type: Date, default: null },
  institution: { type: String, default: '' },
  academic_year_label: { type: String, default: '' },  // תשפ"ז, as the file writes it
  class_name: { type: String, default: '' },        // כיתה — the vendor's class name
  tuition_type: { type: String, default: '' },      // שכר לימוד — a type, not a sum
  tier: { type: String, default: '' },              // דרגה — the subsidy bracket
  start_date: { type: Date, default: null },
  end_date: { type: Date, default: null },
  tags: { type: String, default: '' },
  admin_notes: { type: String, default: '' },
  created_by: { type: String, default: '' },
  created_at: { type: Date, default: null },
  updated_by: { type: String, default: '' },
  updated_at: { type: Date, default: null },
  // When THIS half was last written, and by which file. Separate from the
  // record's own timestamps, which move whenever either export touches it.
  imported_at: { type: Date, default: null },
  source_file: { type: String, default: '' },
}, { _id: false });

const externalEnrollmentSchema = new mongoose.Schema({
  source: { type: String, default: 'clicktac', index: true },
  source_file: { type: String, default: '' },

  /**
   * Which of ClickTac's two exports this row has actually been in.
   *
   * The distinction is not cosmetic: a row that has only ever appeared in the
   * contracts export has no parent, no phone and no payment method, and
   * turning it into a Registration would create a family nobody can call. The
   * promotion guard reads this field.
   *
   * Rows imported before the contracts export was supported carry no value at
   * all. They are, by construction, registrations rows — every one of them came
   * from that file — so an EMPTY list is read as ['registrations'] rather than
   * as "unknown". See sourcesOf() in the controller.
   */
  sources: { type: [String], default: () => ['registrations'] },
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
    // כינוי — only the contracts export asks for it.
    nickname: { type: String, default: '' },
    // ת.ז הנרשם — unique in every export seen so far, and the merge key.
    id_number: { type: String, default: '', index: true },
    // ת.ז. / דרכון. The contracts export says which, and it decides whether
    // the id above may be reduced to its digits — a passport may not.
    id_type: { type: String, default: '' },
    birth_date: { type: Date, default: null },
    gender: { type: String, default: '' },
    // ClickTac's own layer: תינוק / פעוט / בוגר.
    age_group: { type: String, default: '' },
    health_fund: { type: String, default: '' },
    has_allergy: { type: Boolean, default: false },
    allergy_detail: { type: String, default: '' },
    // הערות רפואיות — free text, contracts export only.
    medical_notes: { type: String, default: '' },
    // מלווה — a one-to-one aide, for the few children who have one.
    aide_name: { type: String, default: '' },
    aide_phone: { type: String, default: '' },
    welfare_referred: { type: Boolean, default: false },
  },

  parent1: { type: partySchema, default: () => ({}) },
  parent2: { type: partySchema, default: () => ({}) },

  /**
   * The contracts export's half. `null` until that file has been uploaded for
   * this child — which is a real state and not a missing value: most of the
   * summer, only the registrations export exists.
   */
  contract: { type: contractSchema, default: null },

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
    /**
     * מזומן / לא הוגדר / הו"ק ללא בנק — null when there is nothing to chase.
     *
     * Written at import and recomputed on every read. The stored copy exists
     * so the office can be shown a COUNT and can filter on it; the recompute
     * is what gives the rows imported before this field existed their flag
     * without asking anyone to upload the file again. Where the two disagree
     * the recompute wins, because the rule may have been corrected since.
     */
    payment_alert: { type: paymentAlertSchema, default: null },
  },

  /**
   * Which uploads this child has been in.
   *
   * The export is re-uploaded through the summer as families register and
   * cancel, so a row that DISAPPEARS is a real event — ClickTac dropped the
   * registration entirely rather than marking it cancelled. The record is kept
   * and marked gone, because a child who vanishes from the file still has to
   * be reconciled against the ministry's list.
   */
  presence: {
    is_present: { type: Boolean, default: true },
    first_seen_at: { type: Date, default: Date.now },
    last_seen_at: { type: Date, default: Date.now },
    missing_since: { type: Date, default: null },
  },

  /** What changed between uploads, oldest first. Meaning only, never format. */
  changes: [{
    at: { type: Date, default: Date.now },
    field: { type: String, default: '' },
    from: { type: String, default: '' },
    to: { type: String, default: '' },
    _id: false,
  }],

  /**
   * Where the manager decided this child goes — which beats every file.
   *
   * The ministry's שכבת גיל is a funding bracket and ClickTac's is a form
   * field; neither is a placement. A child of 22 months can belong in בוגרים
   * in one gan and in צעירים in another, and that call is the manager's, made
   * against the child's actual age on 1 September. Once it is made it has to
   * survive the next file: a re-import overwrites the parsed fields, and this
   * is not one of them.
   */
  placement: {
    age_group_override: { type: String, default: '' },   // תינוק / פעוט / בוגר
    classroom_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Classroom', default: null },
    decided_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decided_at: { type: Date, default: null },
    note: { type: String, default: '' },
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

  /**
   * ONE HASH PER EXPORT, because there are two files and they change
   * independently.
   *
   * `content_hash` is the registrations export's parsed meaning, exactly as
   * before. `content_hash_contracts` is the contracts export's. A shared hash
   * would make every contracts re-upload look like a change the moment a
   * phone number moved in the other file, and vice versa — which would turn
   * both no-op checks into noise.
   *
   * A row created by the contracts export alone still has to satisfy the
   * `required` below, and gets `contracts:<hash>` — a value that can never
   * collide with a registrations hash, so the first registrations upload for
   * that child reads as the change it is rather than as "unchanged".
   */
  content_hash: { type: String, required: true, index: true },
  content_hash_contracts: { type: String, default: '', index: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

// One row per child per year per source. A re-import updates in place.
externalEnrollmentSchema.index(
  { source: 1, academic_year: 1, 'child.id_number': 1 },
  { unique: true },
);
externalEnrollmentSchema.index({ branch_id: 1, 'review.status': 1 });

module.exports = mongoose.model('ExternalEnrollment', externalEnrollmentSchema);
