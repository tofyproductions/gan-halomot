#!/usr/bin/env node
/**
 * notification.service.js — createEvent/resolveEvents/deliver/resendDue,
 * against a real Mongo (mongodb-memory-server) with fcm.service and
 * web-push STUBBED (via require.cache, same trick as dotenv) so nothing
 * real ever gets touched and the test can assert exactly what was sent.
 *
 *   node scripts/notification-service.test.js
 */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};

const sent = { fcm: [], web: [] };
const fcmPath = require.resolve('../src/services/fcm.service');
require.cache[fcmPath] = {
  id: fcmPath, filename: fcmPath, loaded: true, children: [], paths: [],
  exports: {
    sendPush: async ({ token, title, body, data }) => {
      sent.fcm.push({ token, title, body, data });
      if (token === 'DEAD_TOKEN') return { ok: false, unregistered: true };
      return { ok: true, unregistered: false };
    },
    isConfigured: () => true,
  },
};
const webPushPath = require.resolve('web-push');
require.cache[webPushPath] = {
  id: webPushPath, filename: webPushPath, loaded: true, children: [], paths: [],
  exports: {
    setVapidDetails: () => {},
    sendNotification: async (subscription, payload) => {
      if (subscription.endpoint === 'https://dead.example/ep') {
        const err = new Error('gone'); err.statusCode = 410; throw err;
      }
      sent.web.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) });
      return { statusCode: 201 };
    },
  },
};

process.env.VAPID_PUBLIC_KEY = 'test-public';
process.env.VAPID_PRIVATE_KEY = 'test-private';

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let failures = 0;
let checks = 0;
function ok(cond, label, detail = '') {
  checks++;
  if (cond) console.log(`  ✅ ${label}`);
  else { failures++; console.log(`  ❌ ${label}${detail ? `  (${detail})` : ''}`); }
}
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), label, `קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(pred, tries = 30) {
  for (let i = 0; i < tries; i++) { if (await pred()) return true; await sleep(50); }
  return await pred();
}

async function main() {
  console.log('=== notification.service.js ===');
  const mongod = await MongoMemoryServer.create({ instance: { dbName: 'gan_notification_service' } });
  await mongoose.connect(mongod.getUri());

  const { User, Branch, NotificationEvent, PushSubscription, WebPushSubscription } = require('../src/models');
  const notificationService = require('../src/services/notification.service');

  const branch = await Branch.create({ name: 'הרצליה' });
  const manager = await User.create({
    email: 'm@x.local', full_name: 'מנהלת', id_number: '111111111', role: 'branch_manager',
    branch_id: branch._id, position: 'x', password_hash: 'x', password_set: true, is_active: true,
  });
  const admin = await User.create({
    email: 'a@x.local', full_name: 'מנהל מערכת', id_number: '222222222', role: 'system_admin',
    branch_id: branch._id, position: 'x', password_hash: 'x', password_set: true, is_active: true,
  });
  const accountant = await User.create({
    email: 'c@x.local', full_name: 'הנהח', id_number: '333333333', role: 'accountant',
    branch_id: branch._id, position: 'x', password_hash: 'x', password_set: true, is_active: true,
  });
  await PushSubscription.create({ user_id: manager._id, fcm_token: 'GOOD_TOKEN', platform: 'android' });
  await PushSubscription.create({ user_id: manager._id, fcm_token: 'DEAD_TOKEN', platform: 'ios' });
  await WebPushSubscription.create({ user_id: manager._id, endpoint: 'https://push.example/ep1', keys: { p256dh: 'p', auth: 'a' } });
  await WebPushSubscription.create({ user_id: manager._id, endpoint: 'https://dead.example/ep', keys: { p256dh: 'p', auth: 'a' } });

  console.log('\nבדיקה 1 — branchManagerIds/accountantIds');
  eq(await notificationService.branchManagerIds(branch._id), [String(manager._id)], '1a מנהלת הסניף');
  eq(await notificationService.branchManagerIds(null), [String(admin._id)], '1b בלי סניף — נופל למנהל מערכת');
  const otherBranch = await Branch.create({ name: 'סניף בלי מנהלת' });
  eq(await notificationService.branchManagerIds(otherBranch._id), [String(admin._id)], '1c סניף בלי מנהלת — נופל למנהל מערכת');
  eq(await notificationService.accountantIds(), [String(accountant._id)], '1d כל ההנה"ח');

  console.log('\nבדיקה 2 — createEvent שולח מיד לכל הערוצים, ומוחק מנוי מת');
  const refId = new mongoose.Types.ObjectId();
  const event = await notificationService.createEvent({
    type: 'new_lead', ref_collection: 'Lead', ref_id: refId, recipient_id: manager._id,
    title: 'כותרת', body: 'טקסט', url: '/leads',
  });
  ok(event.status === 'pending', '2a הרשומה נוצרת pending');
  await waitFor(() => sent.fcm.length >= 2 && sent.web.length >= 1);
  ok(sent.fcm.some(s => s.token === 'GOOD_TOKEN' && s.title === 'כותרת'), '2b נשלח פוש FCM טוב');
  ok(sent.fcm.some(s => s.token === 'DEAD_TOKEN'), '2c ניסיון גם לטוקן המת');
  await waitFor(async () => (await PushSubscription.countDocuments({ fcm_token: 'DEAD_TOKEN' })) === 0);
  eq(await PushSubscription.countDocuments({ fcm_token: 'DEAD_TOKEN' }), 0, '2d והמנוי המת נמחק');
  ok(sent.web.some(s => s.endpoint === 'https://push.example/ep1' && s.payload.title === 'כותרת'), '2e נשלח פוש דפדפן טוב');
  await waitFor(async () => (await WebPushSubscription.countDocuments({ endpoint: 'https://dead.example/ep' })) === 0);
  eq(await WebPushSubscription.countDocuments({ endpoint: 'https://dead.example/ep' }), 0, '2f והמנוי הדפדפן המת נמחק');
  const fresh = await NotificationEvent.findById(event._id).lean();
  ok(!!fresh.last_sent_at, '2g last_sent_at התמלא');
  ok(fresh.next_send_at.getTime() > Date.now() + 55 * 60 * 1000, '2h next_send_at כמעט שעה קדימה');

  console.log('\nבדיקה 3 — createEvent לא כופל שורה קיימת שעדיין ממתינה');
  const again = await notificationService.createEvent({
    type: 'new_lead', ref_collection: 'Lead', ref_id: refId, recipient_id: manager._id,
    title: 'כותרת 2', body: 'טקסט 2', url: '/leads',
  });
  eq(String(again._id), String(event._id), '3a אותה רשומה בדיוק, לא נוצרה שנייה');
  eq(await NotificationEvent.countDocuments({ ref_id: refId, recipient_id: manager._id }), 1, '3b עדיין שורה אחת בלבד במסד');

  console.log('\nבדיקה 4 — resolveEvents סוגר את כל הנמענים בבת אחת');
  const refId2 = new mongoose.Types.ObjectId();
  await notificationService.createEvent({ type: 'punch_pending_manager', ref_collection: 'Punch', ref_id: refId2, recipient_id: manager._id, title: 't', body: 'b', url: '/attendance' });
  await notificationService.createEvent({ type: 'punch_pending_manager', ref_collection: 'Punch', ref_id: refId2, recipient_id: admin._id, title: 't', body: 'b', url: '/attendance' });
  await notificationService.resolveEvents({ ref_collection: 'Punch', ref_id: refId2 });
  eq(await NotificationEvent.countDocuments({ ref_id: refId2, status: 'pending' }), 0, '4a שתי הרשומות נסגרו');
  eq(await NotificationEvent.countDocuments({ ref_id: refId2, status: 'resolved' }), 2, '4b ומסומנות resolved');

  console.log('\nבדיקה 5 — resendDue שולח רק למה שהגיע זמנו');
  sent.fcm.length = 0; sent.web.length = 0;
  const refId3 = new mongoose.Types.ObjectId();
  const notDue = await notificationService.createEvent({ type: 'new_lead', ref_collection: 'Lead', ref_id: refId3, recipient_id: manager._id, title: 'לא עכשיו', body: 'b', url: '/leads' });
  await waitFor(() => sent.web.length >= 1); // the immediate send from createEvent
  sent.fcm.length = 0; sent.web.length = 0;
  await NotificationEvent.updateOne({ _id: notDue._id }, { $set: { next_send_at: new Date(Date.now() + 30 * 60 * 1000) } }); // due in 30 min — not yet
  const due = await NotificationEvent.create({
    type: 'new_lead', ref_collection: 'Lead', ref_id: new mongoose.Types.ObjectId(), recipient_id: manager._id,
    title: 'עכשיו', body: 'b', url: '/leads', status: 'pending', next_send_at: new Date(Date.now() - 1000),
  });
  await notificationService.resendDue();
  ok(sent.web.some(s => s.payload.title === 'עכשיו'), '5a נשלח מה שהגיע זמנו');
  ok(!sent.web.some(s => s.payload.title === 'לא עכשיו'), '5b ולא מה שעדיין לא הגיע זמנו');

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} בדיקות עברו`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(err => { console.error('\n💥', err); process.exit(1); });
