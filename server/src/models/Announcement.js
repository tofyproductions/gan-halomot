const mongoose = require('mongoose');

/**
 * Something the gan wants the families to know.
 *
 * Until now there was no such thing in this system. Everything the gan said to
 * a parent went out of it — a manager's own phone, a WhatsApp group nobody
 * administers, a note in a bag — so nothing was searchable, nothing was
 * recorded, and a family that missed it had no second place to look.
 *
 * WRITTEN BY THE TEACHER, RELEASED BY THE MANAGER. The person who knows that
 * the trip is on Thursday is the one standing in the room, and the person
 * accountable for what the gan says to two hundred families is the one running
 * the branch. Those are different people, so this has two states before it is
 * public and the author cannot move it through both.
 *
 * A REJECTION IS NOT A DELETION. `rejected` keeps the text and records why, so
 * the teacher can see what was wrong with it and send it again. Deleting it
 * would teach her to stop writing them.
 */

/**
 * How it went out, recorded separately from whether it was written.
 *
 * Three channels, and they are not equivalent claims:
 *
 *   portal    — the truth. The announcement is on the parent's screen from the
 *               moment it is published, and stays there.
 *   whatsapp  — a COPY, nothing more. The manager presses a button, the text
 *               lands on her clipboard, and she pastes it into the group
 *               herself. This system does not talk to WhatsApp and cannot know
 *               whether she did, which is why the field is `copied_at` and not
 *               `sent_at`. Reading it as delivery would be a lie in six months
 *               when somebody asks whether the family was told.
 *   sms       — actually sent, by us, and it costs money. See SmsBudget.
 */
const deliverySchema = new mongoose.Schema({
  whatsapp_copied_at: { type: Date, default: null },
  whatsapp_copied_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  sms_sent_at: { type: Date, default: null },
  sms_sent_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  // What the send actually cost, in messages. This is the number the monthly
  // budget is spent against — counted from the recipients the send resolved
  // to, not estimated from the number of children, because a family with one
  // parent on file costs one message and not two.
  sms_recipients: { type: Number, default: 0 },
  sms_failed: { type: Number, default: 0 },
}, { _id: false });

const announcementSchema = new mongoose.Schema({
  // No single-field index: both compound indexes below lead with branch_id,
  // which serves a lookup on it alone.
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },

  /**
   * Which rooms it is for. EMPTY MEANS THE WHOLE BRANCH.
   *
   * Empty rather than "all the ids at the time of writing": a classroom added
   * next month is part of the branch, and an announcement addressed to the
   * branch should reach it without anybody editing an old record.
   */
  classroom_ids: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Classroom' }],

  academic_year: { type: String, required: true, index: true },

  title: { type: String, required: true, trim: true, maxlength: 120 },
  body: { type: String, required: true, trim: true, maxlength: 2000 },

  /**
   * Urgent is not a tone, it is a request to spend money.
   *
   * The only thing this flag decides is whether the SMS button is offered at
   * all. Everything else — where it appears, how it looks — is the same,
   * because an announcement that shouts on the screen and arrives nowhere is
   * the worst of both.
   */
  is_urgent: { type: Boolean, default: false },

  status: {
    type: String,
    enum: ['draft', 'pending', 'published', 'rejected'],
    default: 'draft',
    index: true,
  },

  author_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  author_name: { type: String, default: '' },
  author_role: { type: String, default: '' },

  approved_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  approved_by_name: { type: String, default: '' },
  approved_at: { type: Date, default: null },

  // Required to reject, by the controller rather than by the schema — the
  // field is empty on every other status. A teacher told only "no" writes the
  // same announcement again.
  rejected_reason: { type: String, default: '' },

  published_at: { type: Date, default: null },

  /**
   * When it stops being news.
   *
   * Optional, and null means it stays. A parent scrolling past "the gan is
   * closed tomorrow" three weeks later is reading a false statement, so
   * anything with a date in it should carry one of these; a change of policy
   * should not.
   */
  expires_at: { type: Date, default: null },

  delivery: { type: deliverySchema, default: () => ({}) },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

// The parent's query: this branch, published, not expired, newest first.
announcementSchema.index({ branch_id: 1, status: 1, published_at: -1 });
// The manager's queue.
announcementSchema.index({ branch_id: 1, status: 1, created_at: -1 });

module.exports = mongoose.model('Announcement', announcementSchema);
