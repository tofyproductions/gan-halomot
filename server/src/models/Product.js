const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  supplier_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },
  sku: { type: String, default: '' },
  category: { type: String, default: '' },
  name: { type: String, required: true },
  price_before_vat: { type: Number, default: 0 },
  price_with_vat: { type: Number, default: 0 },
  // A picture of the thing, so ordering is recognising rather than reading.
  // Two fields because there are two kinds: a URL somebody pasted, and bytes
  // we hold ourselves — a photo lifted out of a supplier's price list, which
  // has no URL anywhere.
  image_url: { type: String, default: '' },
  /**
   * The image itself, base64, alongside Document.file_data and
   * Contract.file_data which have always worked this way.
   *
   * `select: false` is the important half. These are ~9KB each and there are
   * forty-one of them in one supplier; without it every GET /api/products
   * would carry 400KB of pictures to a screen that shows them at 50 pixels —
   * on a gan's wifi, on the app that just spent a release getting its first
   * load down to 0.78MB. The bytes come out one at a time, through
   * GET /api/products/:id/image, and the browser caches them from there.
   */
  image_data: { type: String, default: null, select: false },
  /** Unit of sale — קרטון, יחידה, חבילה, שק, גליל, מארז.
   *
   * Not decoration: DALAS sells item 60246 at ₪70 per CARTON of 8 sleeves and
   * item 2101 at ₪3.68 per UNIT, and an order line that says only "1" cannot
   * tell you which one you are about to receive. */
  unit: { type: String, default: '' },
  // הערה קבועה — rides along automatically on every order that includes this
  // product, all the way to the supplier's PDF. This is where "תבלינים של
  // 'טעם וריח' בלבד — אלרגיה לשומשום" lives, so nobody has to remember to
  // retype it and the one time it is forgotten is not the time that matters.
  standing_note: { type: String, default: '' },
  is_active: { type: Boolean, default: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

productSchema.index({ supplier_id: 1 });

module.exports = mongoose.model('Product', productSchema);
