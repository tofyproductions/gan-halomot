#!/usr/bin/env node
/**
 * NotificationEvent — schema sanity: required fields, defaults, the
 * dedup-relevant compound index actually exists.
 *
 *   node scripts/notification-event-model.test.js
 */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let failures = 0;
let checks = 0;
function ok(cond, label, detail = '') {
  checks++;
  if (cond) console.log(`  ✅ ${label}`);
  else { failures++; console.log(`  ❌ ${label}${detail ? `  (${detail})` : ''}`); }
}

async function main() {
  console.log('=== NotificationEvent — schema sanity ===');
  const mongod = await MongoMemoryServer.create({ instance: { dbName: 'gan_notification_event_model' } });
  await mongoose.connect(mongod.getUri());

  const { NotificationEvent, User } = require('../src/models');

  // Ensure indexes are created (required in Mongoose 8+)
  await NotificationEvent.syncIndexes();

  const u = await User.create({
    email: 'x@x.local', full_name: 'בודק', id_number: '999999999',
    role: 'branch_manager', position: 'x', password_hash: 'x', password_set: true, is_active: true,
  });

  const row = await NotificationEvent.create({
    type: 'new_lead', ref_collection: 'Lead', ref_id: new mongoose.Types.ObjectId(),
    recipient_id: u._id, title: 'כותרת', body: 'טקסט', next_send_at: new Date(),
  });
  ok(row.status === 'pending', 'status ברירת מחדל pending');
  ok(row.url === '', 'url ברירת מחדל מחרוזת ריקה');
  ok(row.last_sent_at === null, 'last_sent_at ברירת מחדל null');

  let threw = false;
  try {
    await NotificationEvent.create({ type: 'not_a_real_type', ref_collection: 'Lead', ref_id: new mongoose.Types.ObjectId(), recipient_id: u._id, title: 'x', body: 'x', next_send_at: new Date() });
  } catch { threw = true; }
  ok(threw, 'type לא מהרשימה נדחה');

  const indexes = await NotificationEvent.collection.getIndexes();
  const hasDedupIndex = Object.keys(indexes).some(name => name.includes('type_1_ref_id_1_recipient_id_1_status_1'));
  ok(hasDedupIndex, 'האינדקס לבדיקת כפילות קיים');

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} בדיקות עברו`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(err => { console.error('\n💥', err); process.exit(1); });
