const mongoose = require('mongoose');

/**
 * AgentCommand = a queued instruction from the server to a Pi agent.
 *
 * The agent polls `GET /api/agent/:branchId/pending-commands` on a short
 * interval, executes them locally against the TIMEDOX clock (add user,
 * delete user, reboot, etc.), then POSTs the result back. We keep the
 * full history for audit (who pushed what to which clock when).
 *
 * Note: write-to-clock (add/delete user) is NOT yet supported by node-zklib
 * for this firmware (see Phase 7). The schema is ready so we can enqueue
 * commands the moment we have a library that can execute them.
 */
const agentCommandSchema = new mongoose.Schema({
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  type: {
    type: String,
    enum: [
      'add_user',        // payload: { uid, israeli_id, name, password, card, privilege }
      'delete_user',     // payload: { uid } or { israeli_id }
      'update_user',     // payload: { uid, ...fields }
      'sync_time',       // payload: {}
      'reboot_device',   // payload: {}
      'clear_attendance',// payload: {}  — DANGER, audit-only
      'ping',            // payload: {}  — connectivity test
    ],
    required: true,
  },
  payload: { type: mongoose.Schema.Types.Mixed, default: {} },

  status: {
    type: String,
    enum: ['pending', 'sent', 'confirmed', 'failed', 'cancelled'],
    default: 'pending',
    index: true,
  },
  attempts: { type: Number, default: 0 },
  last_error: { type: String, default: '' },

  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  sent_at: { type: Date, default: null },
  completed_at: { type: Date, default: null },
  result: { type: mongoose.Schema.Types.Mixed, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

agentCommandSchema.index({ branch_id: 1, status: 1, created_at: 1 });

module.exports = mongoose.model('AgentCommand', agentCommandSchema);
