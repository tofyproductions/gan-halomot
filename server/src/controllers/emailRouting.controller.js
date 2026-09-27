/**
 * "מי מקבל מה" — the admin grid behind the office email routing
 * (docs/superpowers/specs/2026-09-27-email-routing-and-contact-design.md).
 *
 *   GET /api/admin/email-routing   topics, the people the grid lists, the saved
 *                                   routing, and who each topic reaches right now
 *   PUT /api/admin/email-routing   { routing: { <topic>: { user_ids, extra_emails } } }
 *
 * system_admin only (the admin router). office-recipients.service owns every
 * rule; this file only reads, validates through it, and writes.
 */
const { Setting } = require('../models');
const R = require('../services/office-recipients.service');

async function payload() {
  const [candidates, saved] = await Promise.all([R.candidates(), R.readRouting()]);
  const routing = {};
  const reaches = {};
  for (const t of R.TOPICS) {
    const e = saved[t.key] || {};
    routing[t.key] = { user_ids: (e.user_ids || []).map(String), extra_emails: e.extra_emails || [] };
    reaches[t.key] = await R.officeEmails(t.key);
  }
  return {
    topics: R.TOPICS,
    candidates: candidates.map(u => ({ id: String(u._id), full_name: u.full_name, role: u.role, email: u.email })),
    routing,
    reaches,
  };
}

async function getRouting(req, res, next) {
  try { res.json(await payload()); } catch (err) { next(err); }
}

async function setRouting(req, res, next) {
  try {
    const ids = (await R.candidates()).map(u => String(u._id));
    const clean = R.cleanRouting(req.body?.routing, ids);
    if (clean.error) return res.status(400).json({ error: clean.error });
    await Setting.findOneAndUpdate({ key: R.ROUTING_KEY }, { value: { topics: clean.topics } }, { upsert: true });
    res.json(await payload());
  } catch (err) { next(err); }
}

module.exports = { getRouting, setRouting };
