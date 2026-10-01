#!/usr/bin/env node
/**
 * A bank feed that stops is silent by nature. Once a day, if the agent has not
 * delivered for 48 hours, the admins hear about it — but not before a bank
 * account exists, and not twice a day.
 *
 *   node scripts/bank-watch.test.js
 */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = { id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) } };
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
let failures = 0;
const eq = (a, b, l) => { const g = a === b; console.log(`  ${g ? '✅' : '❌'} ${l}${g ? '' : ` (${a} ≠ ${b})`}`); if (!g) failures++; };

(async () => {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  const { BankAccount, FinanceSyncLog, User, NotificationEvent } = require('../src/models');
  const { tick } = require('../src/services/bankWatchJob');
  console.log('\n🔕 הבנק שותק\n');

  await User.create({ full_name: 'מנהל', id_number: '900000001', email: 'a@x.l', password_hash: 'x', role: 'system_admin', is_active: true });
  eq((await tick()).notified, 0, 'אין חשבון בנק עדיין — אין התראה');

  await BankAccount.create({ external_id: 'beinleumi:••••0463', institution: 'beinleumi', label: 'ב', type: 'bank' });
  const old = await FinanceSyncLog.create({ source: 'agent', status: 'ok' });
  // created_at is immutable under mongoose timestamps — backdate via the raw collection.
  await FinanceSyncLog.collection.updateOne({ _id: old._id }, { $set: { created_at: new Date(Date.now() - 72 * 3600e3) } });
  eq((await tick()).notified, 1, '72 שעות בלי קליטה — מנהל המערכת מקבל התראה');
  eq((await tick()).notified, 0, 'ולא פעמיים באותו יום');
  eq(await NotificationEvent.countDocuments({ type: 'bank_feed_stale' }), 1, 'אירוע אחד נרשם');

  await FinanceSyncLog.create({ source: 'agent', status: 'ok' });
  eq((await tick(new Date(Date.now() + 86400e3))).notified, 0, 'קליטה טרייה — שקט');

  await mongoose.disconnect(); await mongod.stop();
  console.log(failures ? `\n❌ ${failures} נכשלו` : '\n✅ הכל עבר');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
