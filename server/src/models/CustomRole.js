const mongoose = require('mongoose');
const { ROLES } = require('../constants/roles');

/**
 * A named permission set, built from what one person actually has.
 *
 * The eight built-in roles are the shape of the org chart, not the shape of
 * the permissions people end up with. עינת is a גננת who also files רישום
 * חיצוני and reads the employee cards — so somebody ticked four boxes on her
 * row of the permissions screen, and the next person hired to do the same job
 * got the four boxes ticked again, by hand, from memory, or not at all.
 *
 * A custom role is that tick-list, given a name. It is created FROM a user
 * ("הקם תפקיד מההרשאות של משתמש/ת זה"), and from then on it is the role layer
 * for everyone holding it: `tab_add` / `tab_remove` are what the JWT carries
 * as `role_tab_add` / `role_tab_remove`, INSTEAD of the role-wide override for
 * `base_role` — not merged with it. Two role-layer answers to one question is
 * a question nobody can answer.
 *
 * `base_role` is a real role from ROLES, and a holder's `User.role` stays
 * equal to it in the database. Every branch-scope rule, every requireRole,
 * every `req.user.role === 'system_admin'` in ninety thousand lines keeps
 * working, because nothing anywhere has to learn that custom roles exist. The
 * custom role only ever moves the tab layer.
 */
const customRoleSchema = new mongoose.Schema({
  // The Hebrew label the office actually uses. Unique: two roles with one name
  // is two roles nobody can tell apart on the assignment dropdown.
  name: { type: String, required: true, unique: true, trim: true },
  base_role: { type: String, enum: ROLES, required: true },
  // Relative to the base role's DEFAULT tabs (constants/tabs.js), never to the
  // role-wide override — which this replaces.
  tab_add: { type: [String], default: [] },
  tab_remove: { type: [String], default: [] },
  // Provenance, for the screen: "built from עינת's permissions".
  created_from_user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

module.exports = mongoose.model('CustomRole', customRoleSchema);
