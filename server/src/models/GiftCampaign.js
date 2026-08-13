const mongoose = require('mongoose');

/**
 * A round of gifts — ראש השנה, סוף שנה — and the window parents choose in.
 *
 * A campaign rather than a setting, because the gan runs this twice a year and
 * each round is its own thing: its own dates, its own products, and its own
 * record of what every family chose. Made a setting, last year's choices would
 * be overwritten by this year's and the supplier file for Rosh Hashanah would
 * stop existing the day the end-of-year round opened.
 *
 * Network-wide. Every gan gets the same gifts; what differs is the room level —
 * the babies get one thing and the older children another — so the product is
 * keyed by classroom category rather than by branch or by classroom. That also
 * means adding a branch changes nothing here.
 */
const giftCampaignSchema = new mongoose.Schema({
  name: { type: String, required: true },        // "מתנות ראש השנה 2026"

  // The window, YYYY-MM-DD local. A day at the gan is a calendar day, and an
  // instant would let a timezone close the window an evening early.
  opens_on: { type: String, required: true },
  closes_on: { type: String, required: true },

  // What each room level receives. Keyed by Classroom.category —
  // תינוקייה / צעירים / בוגרים — with the product as free text: the gan orders
  // from a supplier by name, and a catalogue here would be a second place to
  // keep the same list up to date.
  products: { type: mongoose.Schema.Types.Mixed, default: {} },

  // How many photographs a parent picks. Two, because the staff choose one of
  // them to fit the product and a single pick leaves them no room when it is
  // the wrong shape.
  picks_required: { type: Number, default: 2, min: 1, max: 5 },

  // Closed by hand rather than by date alone: the deadline is when parents
  // stop choosing, and the staff still have work to do afterwards.
  is_open: { type: Boolean, default: true },

  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  created_by_name: { type: String, default: '' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

module.exports = mongoose.model('GiftCampaign', giftCampaignSchema);
