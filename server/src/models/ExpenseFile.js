const mongoose = require('mongoose');

/** A manually uploaded document file (<= 10 MB, base64). Mail-sorter files are never stored here. */
const expenseFileSchema = new mongoose.Schema({
  data: { type: String, required: true },
  name: { type: String, default: '' },
  mime: { type: String, default: '' },
  size: { type: Number, default: 0 },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

module.exports = mongoose.model('ExpenseFile', expenseFileSchema);
