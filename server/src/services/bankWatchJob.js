/**
 * Once a day: has the bank-pi agent gone quiet on the gan's account?
 * A feed that stops says nothing — the first sign would otherwise be a month
 * with no bank lines. Admins and the bookkeeper (owner's call, 01.10.2026);
 * not before a bank account exists.
 */
const { BankAccount, FinanceSyncLog, Setting, User } = require('../models');
const { notifyOnce } = require('./notification.service');

const STALE_MS = 48 * 3600 * 1000;
const KEY = 'bank_watch_last_notified';
const ilDay = (d) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });

async function tick(now = new Date()) {
  if (!(await BankAccount.exists({ type: 'bank', is_active: true }))) return { notified: 0, reason: 'no-bank-account' };
  const last = await FinanceSyncLog.findOne({ source: 'agent', status: 'ok' }).sort({ created_at: -1 }).lean();
  if (last && now.getTime() - new Date(last.created_at).getTime() <= STALE_MS) return { notified: 0, reason: 'fresh' };

  const today = ilDay(now);
  const sent = await Setting.findOne({ key: KEY }).lean();
  if (sent?.value === today) return { notified: 0, reason: 'already-today' };

  const admins = await User.find({ role: { $in: ['system_admin', 'accountant'] }, is_active: { $ne: false } }).select('_id').lean();
  const since = last ? new Date(last.created_at).toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' }) : 'אף פעם';
  for (const a of admins) {
    await notifyOnce({
      type: 'bank_feed_stale', ref_collection: 'Setting', ref_id: a._id, recipient_id: a._id,
      title: 'תנועות הבנק לא מתעדכנות',
      body: `קליטה אחרונה מהבנק: ${since}. ייתכן שמחשב הבנק צריך פתיחת כספת.`,
      url: '/bank',
    });
  }
  await Setting.updateOne({ key: KEY }, { $set: { value: today } }, { upsert: true });
  return { notified: admins.length, reason: 'stale' };
}

module.exports = { tick };
