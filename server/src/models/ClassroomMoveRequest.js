const mongoose = require('mongoose');

/**
 * A request to move a child to another room, waiting for the branch manager.
 *
 * The תינוקייה staff know before anyone when a child is ready to move up, and
 * the button is on their board. But the room decides the fee — פעוטות and
 * תינוקייה are different lines in the price matrix — so a move is not a thing
 * the board does, it is a thing the board asks for. Nothing about the child
 * changes until the manager says yes.
 *
 * `keep_on_board` travels with the request because it was answered at the
 * moment the request was made, by the person who knows whether this family
 * still wants the bottle log. Applied on approval, not before.
 */
const STATUSES = ['pending', 'approved', 'rejected'];

const classroomMoveRequestSchema = new mongoose.Schema({
  child_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Child', required: true, index: true },
  child_name: { type: String, default: '' },
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
  from_classroom_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Classroom', default: null },
  to_classroom_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Classroom', required: true },
  from_name: { type: String, default: '' },
  to_name: { type: String, default: '' },

  /** Stay on the תינוקייה board for three months after the move. */
  keep_on_board: { type: Boolean, default: false },

  status: { type: String, enum: STATUSES, default: 'pending', index: true },
  requested_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  requested_by_name: { type: String, default: '' },
  decided_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  decided_by_name: { type: String, default: '' },
  decided_at: { type: Date, default: null },
  reject_reason: { type: String, default: '' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

classroomMoveRequestSchema.statics.STATUSES = STATUSES;
/** One open request per child at a time — the board must not ask twice. */
classroomMoveRequestSchema.index({ child_id: 1, status: 1 });

module.exports = mongoose.model('ClassroomMoveRequest', classroomMoveRequestSchema);
