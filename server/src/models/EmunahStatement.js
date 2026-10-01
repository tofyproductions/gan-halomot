const mongoose = require('mongoose');

// "X" or an empty cell in the sheet is null, never 0.
const num = { type: Number, default: null };

const monthSchema = new mongoose.Schema({
  month_label: { type: String, default: '' },
  month_index: { type: Number, default: null },
  system: num, parents: num, refunds: num, government: num, welfare: num,
}, { _id: false });

const totalsSchema = new mongoose.Schema({
  system: num, parents: num, refunds: num, government: num, welfare: num,
}, { _id: false });

const branchSchema = new mongoose.Schema({
  name: { type: String, default: '' },
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
  months: { type: [monthSchema], default: [] },
  totals: { type: totalsSchema, default: () => ({}) },
}, { _id: false });

const expenseSchema = new mongoose.Schema({
  label: { type: String, default: '' },
  month_label: { type: String, default: null },
  rent: num, misc: num,
}, { _id: false });

const paymentSchema = new mongoose.Schema({
  date: { type: String, default: null }, // YYYY-MM-DD
  amount: num,
  for_month: { type: String, default: null },
}, { _id: false });

const summarySchema = new mongoose.Schema({
  income: num, expenses: num, paid: num, balance: num,
}, { _id: false });

/** One upload of Emunah's monthly settlement workbook, kept as a version — the newest is shown. */
const emunahStatementSchema = new mongoose.Schema({
  academic_year_label: { type: String, default: '' },
  file_name: { type: String, default: '' },
  branches: { type: [branchSchema], default: [] },
  expenses: { type: [expenseSchema], default: [] },
  payments: { type: [paymentSchema], default: [] },
  summary: { type: summarySchema, default: () => ({}) },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

emunahStatementSchema.index({ created_at: -1 });

module.exports = mongoose.model('EmunahStatement', emunahStatementSchema);
