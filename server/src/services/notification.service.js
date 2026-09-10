/**
 * The single place anything in this app raises "someone needs to be told
 * about this" and the single place that decides how it actually reaches
 * them. See docs/superpowers/specs/2026-09-10-push-notifications-design.md.
 *
 * createEvent/resolveEvents are the only functions a controller ever calls.
 * deliver/resendDue exist for the resend job (server/src/index.js) — a
 * controller never calls them directly, so a caller can never be blocked
 * waiting on an actual push provider round-trip.
 */
const mongoose = require('mongoose');
const webpush = require('web-push');
const env = require('../config/env');
const { NotificationEvent, PushSubscription, WebPushSubscription, User } = require('../models');
const fcmService = require('./fcm.service');

const HOUR_MS = 60 * 60 * 1000;

const webPushConfigured = Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
if (webPushConfigured) {
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
}

async function branchManagerIds(branchId) {
  if (branchId) {
    const managers = await User.find({
      role: 'branch_manager',
      is_active: { $ne: false },
      $or: [{ managed_branch_ids: branchId }, { branch_id: branchId }],
    }).select('_id').lean();
    if (managers.length) return managers.map(m => String(m._id));
  }
  const admins = await User.find({ role: 'system_admin', is_active: { $ne: false } }).select('_id').lean();
  return admins.map(a => String(a._id));
}

async function accountantIds() {
  const accountants = await User.find({ role: 'accountant', is_active: { $ne: false } }).select('_id').lean();
  return accountants.map(a => String(a._id));
}

/** Send one event to every channel its recipient has registered. Best-effort per subscription. */
async function deliver(event) {
  const [fcmSubs, webSubs] = await Promise.all([
    PushSubscription.find({ user_id: event.recipient_id }).lean(),
    WebPushSubscription.find({ user_id: event.recipient_id }).lean(),
  ]);

  for (const sub of fcmSubs) {
    try {
      const result = await fcmService.sendPush({
        token: sub.fcm_token, title: event.title, body: event.body, data: { url: event.url || '' },
      });
      if (result.unregistered) await PushSubscription.deleteOne({ _id: sub._id });
    } catch (err) {
      console.error('[notification] FCM send failed:', err.message);
    }
  }

  if (webPushConfigured) {
    for (const sub of webSubs) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          JSON.stringify({ title: event.title, body: event.body, url: event.url || '' })
        );
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await WebPushSubscription.deleteOne({ _id: sub._id });
        } else {
          console.error('[notification] web push send failed:', err.message);
        }
      }
    }
  }

  await NotificationEvent.updateOne(
    { _id: event._id },
    { $set: { last_sent_at: new Date(), next_send_at: new Date(Date.now() + HOUR_MS) } }
  );
}

/**
 * Raise an event. Idempotent: a recipient who already has a pending row for
 * the same (type, ref_id) gets that row back untouched, not a duplicate —
 * so two Punch rows (in+out) staged in one request don't double-notify, and
 * a retry never piles up rows. The actual send happens in the background;
 * this resolves as soon as the row exists.
 */
async function createEvent({ type, ref_collection, ref_id, recipient_id, title, body, url }) {
  const existing = await NotificationEvent.findOne({ type, ref_id, recipient_id, status: 'pending' });
  if (existing) return existing;

  const event = await NotificationEvent.create({
    type, ref_collection, ref_id, recipient_id, title, body, url: url || '',
    status: 'pending', next_send_at: new Date(),
  });
  deliver(event).catch(err => console.error('[notification] immediate send failed:', err.message));
  return event;
}

/** Close every pending row for one underlying record, for every recipient at once. */
async function resolveEvents({ ref_collection, ref_id }) {
  await NotificationEvent.updateMany(
    { ref_collection, ref_id, status: 'pending' },
    { $set: { status: 'resolved', resolved_at: new Date() } }
  );
}

/** Called by the resend job only — (re)delivers everything due right now. */
async function resendDue() {
  const due = await NotificationEvent.find({
    status: 'pending', next_send_at: { $lte: new Date() },
  }).lean();
  for (const event of due) await deliver(event);
  return due.length;
}

module.exports = { createEvent, resolveEvents, resendDue, branchManagerIds, accountantIds };
