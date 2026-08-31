const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password_hash: { type: String, required: true },
  // Login-password gate: false until the user deliberately chooses a login
  // password. While false, they can still log in with name+ID (backward compat)
  // but are nagged to set one every login. Once true, a correct password is
  // REQUIRED to log in. Admin "reset" flips this back to false (never reveals a
  // plaintext password — bcrypt only).
  password_set: { type: Boolean, default: false },
  /**
   * A password somebody else chose. Set when an administrator issues a new one
   * — the person it was handed to has to replace it before doing anything, so
   * that a password which travelled through a telephone call or a text message
   * stops working the moment it has been used once.
   *
   * Enforced in the auth middleware rather than by asking the client nicely:
   * a screen that can be closed is not a requirement.
   */
  must_change_password: { type: Boolean, default: false },
  full_name: { type: String, default: '' },
  role: {
    type: String,
    enum: ['system_admin', 'branch_manager', 'accountant', 'class_leader', 'teacher', 'assistant', 'cook'],
    default: 'teacher',
  },
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
  // Branches the user manages. For branch_manager / accountant roles this is
  // the source of truth for "which branches am I allowed to see". Defaults
  // to an empty list — when empty AND role==='branch_manager', falls back to
  // `[branch_id]` so single-branch managers don't need explicit setup.
  // system_admin ignores this field (always sees everything).
  managed_branch_ids: { type: [mongoose.Schema.Types.ObjectId], ref: 'Branch', default: [] },

  /**
   * Where this person stands in the customer's org chart — the node, not a
   * rank. Null for a gan with no chart, which is most customers.
   *
   * `managed_branch_ids` answers "which branches may I see" and stops being
   * usable at network size: a district head of forty branches maintained as a
   * list of forty ids is forty chances to be wrong, and it says nothing about
   * WHAT they should be shown. The node says both. Everything under it is one
   * indexed query against the materialised `path`, and the level they sit at
   * is what decides whether they get districts, branches, or people — a
   * network director scrolling eighty thousand carers is not a slow screen,
   * it is the wrong screen.
   *
   * The two live together on purpose. `managed_branch_ids` keeps working
   * exactly as it does for every customer that has no tree, and nothing here
   * widens what anybody may see: the node's subtree is a ceiling, never a
   * grant.
   */
  org_unit_id: { type: mongoose.Schema.Types.ObjectId, ref: 'OrgUnit', default: null, index: true },
  phone: { type: String, default: '' },
  id_number: { type: String, default: '', index: true },
  address: { type: String, default: '' },
  position: { type: String, default: '' },
  salary: { type: Number, default: 0 },
  bank_account: { type: String, default: '' },
  bank_branch: { type: String, default: '' },
  bank_number: { type: String, default: '' },
  start_date: { type: Date, default: null },
  is_active: { type: Boolean, default: true },
  webauthn_credentials: [{
    credential_id: { type: String, required: true },
    public_key: { type: String, required: true },
    counter: { type: Number, default: 0 },
    device_name: { type: String, default: 'מכשיר' },
    created_at: { type: Date, default: Date.now },
  }],
  webauthn_challenge: { type: String, default: null },

  /**
   * The one-time code behind "שכחתי סיסמה".
   *
   * Same shape as ParentAccount's, and read by the same service — a code is a
   * code, and two implementations of an expiry rule is one implementation that
   * is wrong. Stored hashed: a database dump is then dead hashes rather than
   * live codes.
   *
   * These are cleared the moment a code is used, expires, or is guessed wrong
   * too many times, so a row carrying them is a reset in flight and nothing
   * else.
   */
  otp_hash: { type: String, default: null },
  otp_expires_at: { type: Date, default: null },
  otp_attempts: { type: Number, default: 0 },
  otp_sent_at: { type: Date, default: null },
  otp_window_started_at: { type: Date, default: null },
  otp_sends_in_window: { type: Number, default: 0 },
  // Tab access overrides on top of role defaults.
  // tab_overrides_add: tab IDs the user gets even though their role wouldn't.
  // tab_overrides_remove: tab IDs the user is denied even though their role would.
  tab_overrides_add: { type: [String], default: [] },
  tab_overrides_remove: { type: [String], default: [] },

  /**
   * When this person last read the decisions on their own requests.
   *
   * A branch manager sends a payroll change, an employee-card change or a rate
   * change, and accounting approves or refuses it — and nothing ever told her.
   * She found out by opening the right screen and pressing the right tab, or
   * more often by noticing the number was different in the payslip.
   *
   * One timestamp on the person rather than a "seen" flag on each request:
   * there are three separate request collections and this reads them all
   * without a migration on any of them, and "what has happened since I last
   * looked" is a question about the READER, not about each request.
   *
   * Null means never looked — everything decided is new to her, which is the
   * right answer on the day this ships.
   */
  decisions_seen_at: { type: Date, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

userSchema.index({ branch_id: 1, role: 1 });

module.exports = mongoose.model('User', userSchema);
