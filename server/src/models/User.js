const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password_hash: { type: String, required: true },
  full_name: { type: String, default: '' },
  role: {
    type: String,
    enum: ['system_admin', 'branch_manager', 'accountant', 'class_leader', 'teacher', 'assistant', 'cook'],
    default: 'teacher',
  },
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
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
  // Tab access overrides on top of role defaults.
  // tab_overrides_add: tab IDs the user gets even though their role wouldn't.
  // tab_overrides_remove: tab IDs the user is denied even though their role would.
  tab_overrides_add: { type: [String], default: [] },
  tab_overrides_remove: { type: [String], default: [] },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

userSchema.index({ branch_id: 1, role: 1 });

module.exports = mongoose.model('User', userSchema);
