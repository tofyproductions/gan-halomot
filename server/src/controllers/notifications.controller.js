const { NotificationEvent, User } = require('../models');

/**
 * The notifications waiting for somebody, on their own screen.
 *
 * NotificationEvent already existed and already knew all of this — one row per
 * recipient per thing, pending until whatever it is about actually happens.
 * What it had was a push channel and nothing else: if the notification arrived
 * while the phone was in a drawer, or the browser had never been given
 * permission, or it was simply read and forgotten, there was no second place
 * to look. The rows were being written, resent hourly, and never displayed
 * anywhere.
 *
 * So this is the second place. Read-only, and deliberately: nothing here
 * dismisses a notification. A row closes when the thing it is about is done —
 * the punch approved, the lead handled — which is the same rule the push
 * channel already follows. A "mark as read" button would let somebody clear a
 * screen without doing the work, and the screen would then be lying about what
 * is outstanding.
 *
 * PENDING ONLY. What is finished is not a notification any more; the record it
 * pointed at is where its history lives.
 */

/** The cap. Nobody reads past the first screenful, and this runs on a dashboard. */
const LIMIT = 100;

function itemOut(row) {
  return {
    id: String(row._id),
    type: row.type,
    title: row.title,
    body: row.body,
    url: row.url || '',
    created_at: row.created_at,
    // How long it has been waiting. Sent as the raw date; how to say it is the
    // screen's business, and "לפני יומיים" is the whole point of showing it.
    last_sent_at: row.last_sent_at || null,
  };
}

/**
 * GET /api/notifications — what is waiting for ME.
 *
 * Scoped to the caller's own id and nothing else. Not by role, not by branch:
 * a notification is addressed to a person, and the row says which.
 */
async function listMine(req, res, next) {
  try {
    const rows = await NotificationEvent.find({ recipient_id: req.user.id, status: 'pending' })
      .sort({ created_at: -1 })
      .limit(LIMIT)
      .lean();

    res.json({ items: rows.map(itemOut), total: rows.length });
  } catch (err) { next(err); }
}

/**
 * GET /api/notifications/by-recipient — everything outstanding, per person.
 *
 * The question this answers is not "what do I have to do" but "what is stuck,
 * and with whom" — a manager on leave with four punches waiting on her is
 * invisible from every other screen in the system. system_admin only: it names
 * every member of staff and what they have not done.
 *
 * Recipients with nothing pending do not appear. This is a list of what is
 * outstanding, not a roll call.
 */
async function listByRecipient(req, res, next) {
  try {
    const rows = await NotificationEvent.find({ status: 'pending' })
      .sort({ created_at: -1 })
      .lean();

    const users = await User.find({ _id: { $in: [...new Set(rows.map(r => String(r.recipient_id)))] } })
      .select('full_name email role').lean();
    const byId = new Map(users.map(u => [String(u._id), u]));

    const groups = new Map();
    for (const row of rows) {
      const id = String(row.recipient_id);
      if (!groups.has(id)) {
        const user = byId.get(id);
        groups.set(id, {
          recipient_id: id,
          // A user who has since been deleted still has rows pointing at them,
          // and saying so is more useful than a blank name.
          recipient_name: user?.full_name || user?.email || 'משתמש שנמחק',
          recipient_role: user?.role || '',
          items: [],
        });
      }
      groups.get(id).items.push(itemOut(row));
    }

    // The longest-suffering first: whoever has the most waiting on them is the
    // reason somebody opened this.
    const out = [...groups.values()].sort((a, b) => b.items.length - a.items.length);

    res.json({ groups: out, total: rows.length });
  } catch (err) { next(err); }
}

module.exports = { listMine, listByRecipient };
