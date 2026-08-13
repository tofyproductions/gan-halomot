const mongoose = require('mongoose');

/**
 * A parent's login — deliberately NOT a User.
 *
 * Staff live in `User`, where a role decides which tabs open, and the whole
 * permission system is built on the assumption that everyone in that
 * collection works here. Parents break that assumption: there will be several
 * hundred of them, they are outside the organisation, and a single mistake in
 * a role check would hand one of them a payroll screen.
 *
 * Keeping them in their own collection means no such mistake is reachable. A
 * token minted here cannot satisfy the staff middleware and a token minted
 * there cannot satisfy this one — not because the roles differ, but because
 * the two never meet.
 *
 * What is NOT stored here is as deliberate: the account holds no list of
 * children. Which children belong to a parent is derived at request time from
 * the registrations, through household.service — the same grouping the rest of
 * the system already uses. A copy kept here would be wrong the first time a
 * child changed classroom, left, or a sibling enrolled.
 *
 * The account is keyed by the parent's ID number because that is what the
 * registrations file a parent under. Both parents of one child each get their
 * own account and see exactly the same thing.
 */
const parentAccountSchema = new mongoose.Schema({
  // The parent's תעודת זהות, digits only. The identity the registrations
  // already file this person under, and what they type to log in.
  // `unique` builds the index; a second `index: true` here would declare it twice.
  id_number: { type: String, required: true, unique: true, trim: true },

  // Normalised to 05XXXXXXXX at write time. Every one-time code goes here and
  // nowhere else — a parent who changes phone must go through the office, or
  // changing it would be the account takeover this whole design prevents.
  phone: { type: String, default: '', index: true },

  full_name: { type: String, default: '' },

  // bcrypt, never a reversible form. Empty until the parent activates.
  password_hash: { type: String, default: '' },
  // False until a code has been verified AND a password chosen. While false
  // the account cannot be logged into at all — it exists only as a claim.
  activated: { type: Boolean, default: false },

  webauthn_credentials: [{
    credential_id: { type: String, required: true },
    public_key: { type: String, required: true },
    counter: { type: Number, default: 0 },
    device_name: { type: String, default: 'מכשיר' },
    created_at: { type: Date, default: Date.now },
  }],
  webauthn_challenge: { type: String, default: null },

  // --- One-time code, for activation and for password reset ---
  // Hashed, so a leaked database dump is not a pile of live codes.
  otp_hash: { type: String, default: null },
  otp_expires_at: { type: Date, default: null },
  // Wrong guesses against the current code. The code dies at the limit, so a
  // six-digit secret cannot be walked through.
  otp_attempts: { type: Number, default: 0 },
  // When the last code went out, and how many have gone out in the current
  // window — one parent tapping "send again" must not spend the package.
  otp_sent_at: { type: Date, default: null },
  otp_sends_in_window: { type: Number, default: 0 },
  otp_window_started_at: { type: Date, default: null },

  // --- Changing the phone ---
  //
  // Its own code, with its own expiry and its own counters, deliberately not
  // the fields above. They are the same shape and they cannot be the same
  // storage: a parent asking to change their number while a password reset is
  // in flight would overwrite the reset code with one sent to a different
  // phone. And this code must go to the NEW number — proving the parent holds
  // it — which is the entire security of the operation, since the number is
  // where every future code will be sent.
  phone_change: {
    new_phone: { type: String, default: null },
    otp_hash: { type: String, default: null },
    otp_expires_at: { type: Date, default: null },
    otp_attempts: { type: Number, default: 0 },
    otp_sent_at: { type: Date, default: null },
    otp_sends_in_window: { type: Number, default: 0 },
    otp_window_started_at: { type: Date, default: null },
  },

  // --- May this person activate at all ---
  //
  // True for everybody the gan itself entered: a parent on a registration, or
  // a second parent typed in by the office, has already been vouched for by
  // somebody who works here.
  //
  // False only for a second parent added by the OTHER parent through the
  // portal. That is a person nominating a second person to see a child's
  // records, and the gan gets to decide — otherwise the portal would let one
  // parent hand access to anyone whose ID number they know, and a separated
  // family is exactly where that goes wrong.
  //
  // Separate from is_active because they answer different questions and are
  // set by different people: this one is "was this claim ever accepted", and
  // is_active is "is the account open now".
  access_approved: { type: Boolean, default: true },
  invited_by: { type: mongoose.Schema.Types.ObjectId, ref: 'ParentAccount', default: null },
  invited_at: { type: Date, default: null },
  access_approved_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  access_approved_at: { type: Date, default: null },

  // Set by staff. The only thing that closes an account: no date, no
  // automatic expiry, so the gap between one school year and the next never
  // locks a parent out mid-enrolment.
  is_active: { type: Boolean, default: true },

  last_login_at: { type: Date, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

module.exports = mongoose.model('ParentAccount', parentAccountSchema);
