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

  // Set by staff. The only thing that closes an account: no date, no
  // automatic expiry, so the gap between one school year and the next never
  // locks a parent out mid-enrolment.
  is_active: { type: Boolean, default: true },

  last_login_at: { type: Date, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

module.exports = mongoose.model('ParentAccount', parentAccountSchema);
