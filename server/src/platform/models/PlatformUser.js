const mongoose = require('mongoose');

/**
 * Us. The two or three people who can create a customer, price one, or switch
 * one off.
 *
 * Deliberately NOT the User model. A gan's system_admin is the most powerful
 * person inside one customer and must be the least powerful thing here — if
 * the two shared a collection, a role string edited in a gan's own database
 * would be a route into every other customer. Different database, different
 * signing key, different login.
 */
const platformUserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password_hash: { type: String, required: true },
  full_name: { type: String, default: '' },
  // owner may create and delete customers; support may read and open a session.
  role: { type: String, enum: ['owner', 'support'], default: 'support' },
  is_active: { type: Boolean, default: true },
  last_login_at: { type: Date, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

module.exports = platformUserSchema;
