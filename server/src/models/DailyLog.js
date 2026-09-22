const mongoose = require('mongoose');

/**
 * One child, one day, in the תינוקייה.
 *
 * Replaces a Google Sheet where the day lived in a single row that was wiped
 * every night and copied into a history tab as a JSON blob. That shape worked
 * until you wanted to ask a question across days — "how did she sleep this
 * month", "when did the bottles get smaller" — at which point the answer was
 * locked inside 268 rows of stringified JSON.
 *
 * So the day is a document, keyed by child and date, and it is never wiped.
 * "Today's board" is a query for today; the history is the same query for
 * another date, and the nightly reset stops being a destructive operation that
 * has to archive before it deletes.
 *
 * The field names are the gan's, in Hebrew, because the staff read them on the
 * screen and the kitchen works from the same words. Translating them here
 * would only mean translating them back in three places.
 */
const dailyLogSchema = new mongoose.Schema({
  child_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Child', required: true, index: true },
  // Snapshot: the board must still read correctly for a child who has since
  // left or been renamed, and the history is read long after the fact.
  child_name: { type: String, default: '' },
  classroom_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Classroom', default: null, index: true },
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },

  // YYYY-MM-DD in local time. A string rather than a Date on purpose: a day at
  // the gan is a calendar day, and storing it as an instant invites a timezone
  // to move a morning into the previous evening.
  date: { type: String, required: true, index: true },

  // Did the child come in at all. Blank means nobody has said yet, which is
  // different from מסומן חסר — the board shows the two differently.
  attendance: { type: String, enum: ['', 'הגיע', 'חסר'], default: '' },
  // True when the system filled `attendance` in rather than a person: a staff
  // entry implies the child is here, a parent's "not coming" implies not. An
  // inferred mark yields to the next fact; a mark a person set does not.
  attendance_auto: { type: Boolean, default: false },

  // --- What the parent sent from home, before the day starts ---
  home: {
    wake_time: { type: String, default: '' },     // HH:MM
    meal_time: { type: String, default: '' },     // HH:MM
    meal_amount: { type: String, default: '' },   // a portion, or free text ("120 מ״ל")
    parent_note: { type: String, default: '' },
    // The parent said, from home, that the child is not coming today.
    not_coming: { type: Boolean, default: false },
  },

  // --- What the staff record through the day ---
  // Three meals, each with how much was eaten and how much formula was taken.
  // Kept as strings: the portions are a fixed list the gan edits for itself,
  // and the bottle sizes are millilitres that arrive as "60" or "60+40".
  meals: {
    breakfast: { amount: { type: String, default: '' }, formula: { type: String, default: '' } },
    lunch: { amount: { type: String, default: '' }, formula: { type: String, default: '' } },
    snack: { amount: { type: String, default: '' }, formula: { type: String, default: '' } },
  },

  // Two naps, each a lying-down time and a waking time. A start with no end is
  // a child who is asleep right now — the board and the parent's live view
  // both rely on being able to say that.
  sleep: {
    morning: { start: { type: String, default: '' }, end: { type: String, default: '' } },
    noon: { start: { type: String, default: '' }, end: { type: String, default: '' } },
  },

  diapers: { type: String, default: '' },
  // What the family needs to bring tomorrow. Several at once, so a list.
  missing: { type: [String], default: [] },
  staff_note: { type: String, default: '' },

  /**
   * Fields where the sheet and this record both moved since the last sync.
   *
   * The sheet's value won and is in the field above; this is what ours held,
   * kept so the board can show it and the person in the room can settle it.
   * Never a silent overwrite — see services/sheet-sync/three-way.js.
   *
   * Cleared for a field the moment somebody edits that field on the board:
   * looking at both values and choosing one IS the resolution, and leaving
   * the note up afterwards would make it furniture.
   */
  sync_conflicts: {
    type: [{
      field: { type: String, default: '' },
      ours: { type: mongoose.Schema.Types.Mixed, default: '' },
      at: { type: Date, default: Date.now },
    }],
    default: [],
  },

  // Who touched it last, for the staff's own sake when two people share a room.
  updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  updated_by_name: { type: String, default: '' },

  /**
   * Set only by the one-off import of the old Google Sheet, never by the board.
   *
   * Empty on every row a member of staff has ever written, and that is the
   * point: four thousand rows arriving at once need a way to be found again
   * and taken back out, and "everything created in the last ten minutes" is
   * not one — the gan is open and writing its own day while the import runs.
   *
   * Holds the run's id, e.g. "nursery-sheet:כפר סבא - קפלן:20260915T214003Z",
   * so one branch's import can be undone without touching the other's, and a
   * second attempt can be undone without touching the first.
   */
  import_source: { type: String, default: '', index: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

// One row per child per day, enforced rather than assumed — two teachers
// opening the board at once must not create two days.
dailyLogSchema.index({ child_id: 1, date: 1 }, { unique: true });
// The board's own query.
dailyLogSchema.index({ date: 1, classroom_id: 1 });

module.exports = mongoose.model('DailyLog', dailyLogSchema);
