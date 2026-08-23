const mongoose = require('mongoose');

/**
 * What one customer owed for one month, frozen.
 *
 * WHY IT HAS TO BE FROZEN. `tenant.monthlyCharge(children)` works out the
 * charge from the child count, and the console reads that count live — which is
 * right for a screen and wrong for an invoice. A live figure means March's bill
 * changes in May because two children joined, and the customer is right and we
 * are wrong in an argument we cannot win, because we have no record of what we
 * charged or why.
 *
 * So a billing run writes down the count, the rate it used, and the amount, on
 * the day it ran. Afterwards the number is a fact rather than a calculation. If
 * the pricing changes later, past months keep the price they were billed at —
 * that is the whole point of storing the rate alongside the amount instead of
 * looking it up again.
 *
 * `breakdown` records HOW the number was reached, in words: which tier applied,
 * whether the minimum bit, whether the month was free. "Why is this ₪400 when
 * we have three children" is the first question a customer asks, and the answer
 * has to be on the row rather than reconstructed from what the code does today.
 *
 * A month is written once per customer and rerunning is deliberate — see
 * `--recompute` in the billing script. A billing run that silently overwrote
 * yesterday's numbers would be the same problem as computing them live.
 */
const billingPeriodSchema = new mongoose.Schema({
  tenant_id: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  tenant_slug: { type: String, required: true },
  tenant_name: { type: String, default: '' },

  month: { type: String, required: true },     // 'YYYY-MM'

  children: { type: Number, default: 0 },      // the count this was billed on
  rate: { type: Number, default: 0 },          // per child, as applied
  amount: { type: Number, default: 0 },        // what is owed
  currency: { type: String, default: 'ILS' },

  // In words, for the customer who asks.
  breakdown: { type: String, default: '' },

  // draft  — computed, not sent
  // issued — the customer has been told
  // paid   — settled
  // void   — written off; kept rather than deleted, because a month that
  //          vanishes is a month nobody can explain later
  status: { type: String, enum: ['draft', 'issued', 'paid', 'void'], default: 'draft', index: true },

  computed_at: { type: Date, default: Date.now },
  issued_at: { type: Date, default: null },
  paid_at: { type: Date, default: null },
  note: { type: String, default: '' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

billingPeriodSchema.index({ month: 1, tenant_id: 1 }, { unique: true });

module.exports = billingPeriodSchema;
