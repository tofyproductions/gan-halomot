const mongoose = require('mongoose');

const employeeRequestSchema = new mongoose.Schema({
  // user_id links to a login (when the employee self-files). For admin-recorded
  // requests on clock-only employees there may be no user, so it's optional and
  // we key on employee_id instead.
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null, index: true },
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
  type: {
    type: String,
    // 'pregnancy_exam' = היעדרות לבדיקות הריון (§7 חוק עבודת נשים): hour-granular,
    // paid at full wage, drawn against the per-pregnancy 40h (or 20h) pool. Carries
    // an optional medical certificate in medical_file_data like a sick note.
    enum: ['vacation', 'sick', 'pregnancy_exam'],
    required: true,
  },
  from_date: { type: String, required: true }, // YYYY-MM-DD (for pregnancy_exam = the exam date)
  to_date: { type: String, default: null },
  reason: { type: String, default: null },
  // pregnancy_exam only: hours drawn on this exam date (e.g. 2.5). Ignored for
  // other types. The running 40h cap is enforced when computing the balance.
  exam_hours: { type: Number, default: null },
  // Approval chain (accountant is final):
  //   employee submits → 'pending_manager' → manager → 'pending_accountant'
  //   → accountant/admin → 'approved' (only then applied to payroll).
  //   Manager-created requests start at 'pending_accountant'.
  //   'pending' is the legacy single-stage value, treated as pending_manager.
  status: {
    type: String,
    enum: ['pending', 'pending_manager', 'pending_accountant', 'approved', 'rejected'],
    default: 'pending_manager',
  },
  // Stage-1 (manager) decision.
  manager_reviewed_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  manager_reviewed_at: { type: Date, default: null },
  // Final (accountant/admin) decision.
  reviewed_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reviewed_at: { type: Date, default: null },
  medical_file_data: { type: String, default: null }, // base64 for sick certificate
  medical_file_name: { type: String, default: null },
  // Per-certificate override: pay every day of THIS spell at 100% (skip the
  // statutory day-1=0 / days-2-3=50% brackets). Used for the "שלם מהיום הראשון"
  // button. Employee-level policy='full' has the same effect for all certs.
  pay_from_first_day: { type: Boolean, default: false },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

employeeRequestSchema.index({ user_id: 1, type: 1 });
employeeRequestSchema.index({ branch_id: 1, status: 1 });

module.exports = mongoose.model('EmployeeRequest', employeeRequestSchema);
