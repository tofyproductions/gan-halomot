const mongoose = require('mongoose');

const childSchema = new mongoose.Schema({
  registration_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Registration', required: true },
  child_name: { type: String, required: true },
  child_id_number: { type: String, default: null },
  birth_date: { type: Date, default: null },
  classroom_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Classroom', default: null },
  parent_name: { type: String, default: '' },
  parent_id_number: { type: String, default: null },
  phone: { type: String, default: null },
  email: { type: String, default: null },
  parent2_name: { type: String, default: null },
  parent2_id_number: { type: String, default: null },
  parent2_phone: { type: String, default: null },
  parent2_email: { type: String, default: null },
  address: { type: String, default: null },
  medical_alerts: { type: String, default: null },
  allergies: { type: String, default: null },
  emergency_contact: { type: String, default: null },
  emergency_phone: { type: String, default: null },
  notes: { type: String, default: null },
  academic_year: { type: String, required: true },

  /**
   * Boy or girl, and empty until somebody says.
   *
   * It exists for one reason: אבא של שבת and אמא של שבת are two rotations, not
   * one, and the gan cannot be asked to fill in a field for every child before
   * the feature works at all. So it stays empty and is set from the picker, one
   * tap, at the moment a gananet is choosing that child anyway — by the person
   * who knows, on the day it matters.
   */
  gender: { type: String, enum: ['boy', 'girl', ''], default: '' },

  is_active: { type: Boolean, default: true },

  /**
   * הסרה זמנית בידי המנהלת — the child dropped off the ClickTac/תמ"ת list and
   * the manager saw it before the next file upload proved it. Set together
   * with is_active=false; distinguishes this reversible, human-declared state
   * from an ordinary deactivation, so the next file import may automatically
   * restore the child if their ת"ז shows up in it again.
   */
  hidden_at: { type: Date, default: null },
  hidden_by_name: { type: String, default: '' },
  hide_note: { type: String, default: '' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

childSchema.index({ registration_id: 1 });
childSchema.index({ classroom_id: 1, academic_year: 1 });

// Same reason as Employee: the list is filtered by year and sorted by name,
// and an in-memory sort makes a page cost what the whole list costs.
childSchema.index({ academic_year: 1, child_name: 1 });

module.exports = mongoose.model('Child', childSchema);
