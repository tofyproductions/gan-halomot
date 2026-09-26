const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema({
  product_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
  sku: { type: String, default: '' },
  name: { type: String, required: true },
  qty: { type: Number, required: true },
  // What one `qty` IS — קרטון, יחידה, שק. Snapshotted with the price it belongs
  // to: "2" on a line the supplier reads is an instruction, and two cartons and
  // two units are different deliveries at the same number.
  unit: { type: String, default: '' },
  unit_price: { type: Number, default: 0 },
  total: { type: Number, default: 0 },
  // Snapshot of the product's standing_note at order time — the note the
  // supplier actually saw stays with the order even if the product is edited.
  note: { type: String, default: '' },
  // Set when the order is received (Phase 3 receive flow).
  qty_received: { type: Number, default: 0 },
  expiry_date: { type: Date, default: null },
  shelf_number: { type: String, default: '' },
  stock_item_id: { type: mongoose.Schema.Types.ObjectId, ref: 'StockItem', default: null },
  batch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'StockBatch', default: null },
});

const orderSchema = new mongoose.Schema({
  order_number: { type: String, required: true, unique: true },
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  supplier_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },
  status: {
    type: String,
    // 'receiving' is transient: the receive endpoint's claim, held only while
    // the stock is being booked in, so a double-click cannot book it twice.
    enum: ['draft', 'pending', 'approved', 'sent', 'pending_receive', 'receiving', 'received', 'received_partial', 'cancelled'],
    default: 'pending',
  },
  items: [orderItemSchema],
  total_amount: { type: Number, default: 0 },
  notes: { type: String, default: '' },
  created_by: { type: String, default: '' },
  approved_by: { type: String, default: '' },
  approved_at: { type: Date, default: null },
  pending_receive_at: { type: Date, default: null },
  received_at: { type: Date, default: null },
  received_by_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  received_by_name: { type: String, default: '' },

  /**
   * Several branches ordering together from one supplier. A group is N draft
   * orders sharing this id — one per branch, each with its own items, its own
   * delivery address and its own stock receive. null = an order on its own.
   */
  group_id: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
  /** Who invited this branch into the group (empty when the branch started it). */
  group_invited_by: { type: String, default: '' },
  /** The inviting branch's name, for "הוזמנת על ידי … מסניף …". */
  group_invited_from: { type: String, default: '' },
  /**
   * When the supplier was written to. Orders from before this field carry null
   * and their created_at IS the send time — creation used to send on the spot.
   */
  sent_at: { type: Date, default: null },
  sent_by: { type: String, default: '' },

  /**
   * What happened when this order was mailed to the supplier.
   *
   * Sending was wrapped in a try/catch that logged and moved on, so a failed
   * send and a delivered order looked identical on the record — the model had
   * no email fields at all, and the first sign of trouble was the delivery
   * that never came.
   *
   * `never` is the default and is what every order written before these fields
   * existed reads as: not a claim that nothing was sent, but an honest "this
   * record predates the question". Nothing is backfilled, and no existing
   * order changes meaning.
   *
   * See services/order-delivery.service.js — `sent` is written only when a
   * provider explicitly accepted the message.
   *
   * `email_message_id` is what a future bounce would be matched against: a
   * supplier's server can accept a message and reject it minutes later, which
   * arrives as mail and can only be caught by reading a mailbox.
   */
  email_status: {
    type: String,
    enum: ['never', 'sent', 'failed', 'skipped'],
    default: 'never',
  },
  email_attempted_at: { type: Date, default: null },
  email_message_id: { type: String, default: '' },
  email_recipients: { type: [String], default: [] },
  email_error: { type: String, default: '' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

orderSchema.index({ branch_id: 1, status: 1 });

module.exports = mongoose.model('Order', orderSchema);
