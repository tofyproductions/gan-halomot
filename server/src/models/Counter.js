const mongoose = require('mongoose');

/**
 * Atomic sequence counters — one row per named sequence.
 *
 * Born for order numbers: `'ORD-' + Date.now()` was a business key with
 * millisecond resolution under a unique index, so two orders created in the
 * same millisecond (a group invite creates one per branch in a loop) threw
 * E11000 at a user as an unexplained 500. `$inc` on one row can't collide.
 */
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true },   // sequence name, e.g. 'order_number'
  seq: { type: Number, default: 0 },
});

const Counter = mongoose.models.Counter || mongoose.model('Counter', counterSchema);

/** Next value of the named sequence — atomic, safe under any concurrency. */
async function nextSeq(name) {
  const doc = await Counter.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, new: true },
  );
  return doc.seq;
}

module.exports = { Counter, nextSeq };
