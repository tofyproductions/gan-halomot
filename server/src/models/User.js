const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password_hash: { type: String, required: true },
  full_name: { type: String, default: '' },
  role: {
    type: String,
    enum: ['system_admin', 'branch_manager', 'employee'],
    default: 'employee',
  },
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
  phone: { type: String, default: '' },
  id_number: { type: String, default: '' },
  address: { type: String, default: '' },
  position: { type: String, default: '' },
  salary: { type: Number, default: 0 },
  bank_account: { type: String, default: '' },
  bank_branch: { type: String, default: '' },
  bank_number: { type: String, default: '' },
  start_date: { type: Date, default: null },
  is_active: { type: Boolean, default: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

userSchema.index({ branch_id: 1, role: 1 });

module.exports = mongoose.model('User', userSchema);
