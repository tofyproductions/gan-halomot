'use strict';

/**
 * Who in the office hears about what — the one answer for every office email
 * (docs/superpowers/specs/2026-09-27-email-routing-and-contact-design.md).
 *
 * Until 27.09.2026 fifteen places each asked `User.find({role: …})` and every
 * one of them mailed everybody with an office role. The owner wants mail by
 * TOPIC: the developer hears about faults, the office about employees and
 * payroll, the CEO about everything. The answer lives in ONE Setting
 * (`email_routing`), edited in the admin grid, and is read only here.
 *
 * ── The rules ──
 *
 * LIVE. A routed person who left (is_active false) or is a stand-in
 * (is_test_account) is skipped — the same two rules branch-recipients uses.
 *
 * REAL ADDRESS. Most logins carry a placeholder `<ת"ז>@gan-halomot.local`,
 * and the first admin accounts were made on `ganhalomot.co.il`, a domain
 * nobody registered — every mail to either vanished without a bounce anyone
 * saw. Neither is an address.
 *
 * NEVER SILENCE. A topic nobody is routed to (or everybody on it left) falls
 * back to the live system admins. A fault report that reaches the wrong
 * person is a nuisance; one that reaches nobody is the failure this whole
 * system exists to prevent.
 *
 * Not permission. Nothing here decides what anybody may read or do — except
 * that the contact inbox shows a topic to the people routed on it
 * (officeUserIds), which is exactly the question this file answers.
 */
const mongoose = require('mongoose');
const { User, Setting } = require('../models');

const ROUTING_KEY = 'email_routing';

/** The roles that can sit in the grid. */
const OFFICE_ROLES = ['system_admin', 'accountant', 'admin_viewer'];

const TOPICS = [
  { key: 'system_faults', label: 'תקלות במערכת', kind: 'mail' },
  { key: 'hr', label: 'עובדים, חוזים ושכר', kind: 'mail' },
  { key: 'parents_finance', label: 'הורים וכספים', kind: 'mail' },
  { key: 'contact_tech', label: 'פנייה: תקלה באפליקציה', kind: 'contact' },
  { key: 'contact_graphics', label: 'פנייה: גרפיקה ותמונות', kind: 'contact' },
  { key: 'contact_payroll', label: 'פנייה: שכר, שעות, תלושים ומסמכים', kind: 'contact' },
  { key: 'contact_general', label: 'פנייה: שאלה כללית / אחר', kind: 'contact' },
];
const TOPIC_KEYS = new Set(TOPICS.map(t => t.key));

const LIVE = { is_active: { $ne: false }, is_test_account: { $ne: true } };
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/** An address mail can actually reach — see REAL ADDRESS above. */
function isRealEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  return EMAIL_RE.test(e) && !e.endsWith('@gan-halomot.local') && !e.endsWith('@ganhalomot.co.il');
}

const norm = (e) => String(e).trim().toLowerCase();

function assertTopic(topic) {
  if (!TOPIC_KEYS.has(topic)) throw new Error(`unknown office topic: ${topic}`);
}

/** The Setting's topics map; `{}` when nothing was ever saved. */
async function readRouting() {
  const doc = await Setting.findOne({ key: ROUTING_KEY }).lean();
  return doc?.value?.topics || {};
}

async function routed(topic) {
  assertTopic(topic);
  const entry = (await readRouting())[topic] || {};
  const ids = (entry.user_ids || []).filter(id => mongoose.isValidObjectId(id));
  const users = ids.length
    ? await User.find({ _id: { $in: ids }, ...LIVE }).select('_id email').lean()
    : [];
  return {
    users: users.filter(u => isRealEmail(u.email)),
    extra: (entry.extra_emails || []).filter(isRealEmail),
  };
}

/** The addresses to mail for this topic. Never empty while any admin exists. */
async function officeEmails(topic) {
  const { users, extra } = await routed(topic);
  let out = [...users.map(u => u.email), ...extra];
  if (!out.length) {
    out = (await User.find({ role: 'system_admin', ...LIVE }).select('email').lean())
      .map(u => u.email).filter(isRealEmail);
  }
  return [...new Set(out.map(norm))];
}

/**
 * The routed PEOPLE for this topic, as user id strings — for push and for the
 * contact inbox's visibility. No fallback here: who may read a topic is a
 * decision, not a safety net (the inbox handles orphaned topics itself).
 */
async function officeUserIds(topic) {
  const { users } = await routed(topic);
  return users.map(u => String(u._id));
}

/** Everybody the grid may list: office roles, live, with a real address. */
async function candidates() {
  const users = await User.find({ role: { $in: OFFICE_ROLES }, ...LIVE })
    .select('_id full_name role email').sort({ full_name: 1 }).lean();
  return users.filter(u => isRealEmail(u.email));
}

module.exports = {
  ROUTING_KEY, OFFICE_ROLES, TOPICS, isRealEmail,
  readRouting, officeEmails, officeUserIds, candidates,
};
