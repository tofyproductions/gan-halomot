#!/usr/bin/env node
/**
 * An order that waits, and several branches that order together.
 *
 * Until now the only button sent the supplier an email on the spot. There was
 * no way to prepare an order and leave it, no way for somebody else at the
 * branch to finish it, and no way for two branches to reach one supplier's
 * minimum together. The status 'draft' existed in the enum and nothing ever
 * wrote it.
 *
 *   node scripts/order-group.test.js
 */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};

// No mail leaves a test. Every send is recorded so the test can count them.
const emailPath = require.resolve('../src/services/email.service');
const sentMail = [];
require.cache[emailPath] = {
  id: emailPath, filename: emailPath, loaded: true, children: [], paths: [],
  exports: {
    sendOrderEmail: async (args) => {
      sentMail.push({ kind: 'single', ...args });
      return { sent: true, messageId: `<single-${sentMail.length}@test>`, provider: 'test', recipients: ['s@x.co.il'] };
    },
    sendGroupOrderEmail: async (args) => {
      sentMail.push({ kind: 'group', ...args });
      return { sent: true, messageId: `<group-${sentMail.length}@test>`, provider: 'test', recipients: ['s@x.co.il'] };
    },
    dispatchEmail: async () => ({ ok: true }),
  },
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
function eq(actual, expected, label) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), label,
    `קיבלנו ${JSON.stringify(actual)}, ציפינו ${JSON.stringify(expected)}`);
}
function head(t) { console.log(`\n${t}`); }

let mongod;

async function main() {
  console.log('=== הזמנה בהמתנה והזמנה משותפת ===');
  mongod = await MongoMemoryServer.create({ instance: { dbName: 'order_group_test' } });
  const uri = mongod.getUri();
  process.env.MONGODB_URI = uri;
  await mongoose.connect(uri);

  const { Order, Supplier, Branch, User, NotificationEvent } = require('../src/models');
  const c = require('../src/controllers/order.controller');

  /** Call a controller the way express would. branchScope: null = admin (all branches). */
  function invoke(fn, { body = {}, params = {}, query = {}, user, branchScope = null } = {}) {
    return new Promise((resolve, reject) => {
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(payload) { resolve({ status: this.statusCode, body: payload }); },
        send(payload) { resolve({ status: this.statusCode, body: payload }); },
      };
      fn({ body, params, query, user, branchScope }, res, (err) => (err ? reject(err) : resolve({ status: 500, body: null })));
    });
  }

  const supplier = await Supplier.create({ name: 'שאבי', contact_email: 's@x.co.il', vat_rate: 1.18, min_order_amount: 1200 });
  const sid = String(supplier._id);
  const branchA = await Branch.create({ name: 'סניף א', address: 'רחוב א 1' });
  const branchB = await Branch.create({ name: 'סניף ב', address: 'רחוב ב 2' });
  const branchC = await Branch.create({ name: 'סניף ג', address: 'רחוב ג 3' });
  const managerB = await User.create({
    email: 'b@gan.co.il', password_hash: 'x', full_name: 'מנהלת ב', role: 'branch_manager',
    branch_id: branchB._id, managed_branch_ids: [branchB._id], is_active: true,
  });
  const adminUser = { id: 'admin1', role: 'system_admin', full_name: 'מנהל מערכת', email: 'admin@gan.co.il' };
  const userA = { id: 'ua', role: 'branch_manager', full_name: 'מנהלת א', email: 'a@gan.co.il' };
  const userB = { id: String(managerB._id), role: 'branch_manager', full_name: 'מנהלת ב', email: 'b@gan.co.il' };
  const scopeA = [String(branchA._id)];
  const scopeB = [String(branchB._id)];

  const item = (name, qty, unit_price) => ({ name, sku: name, qty, unit_price });

  // ---------------------------------------------------------------- 0 ------
  head('0 — השדות קיימים על המודל');
  {
    const o = new Order({ order_number: 'ORD-0', branch_id: branchA._id, supplier_id: supplier._id, items: [] });
    eq(o.group_id, null, '0a group_id ברירת מחדל null');
    eq(o.sent_at, null, '0b sent_at ברירת מחדל null');
    eq(o.group_invited_by, '', '0c group_invited_by ריק');
    eq(o.sent_by, '', '0d sent_by ריק');
    const ev = new NotificationEvent({ type: 'order_shared', ref_collection: 'Order', ref_id: o._id, recipient_id: managerB._id, title: 't', body: 'b', next_send_at: new Date() });
    eq(ev.validateSync(), undefined, '0e order_shared הוא סוג התראה חוקי');
  }

  // Later tasks append their sections here, before the summary.
  // __TASKS_APPEND_HERE__

  console.log(`\n${failures === 0 ? '🎉' : '💥'} ${checks - failures}/${checks} עברו`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  try { await mongoose.disconnect(); if (mongod) await mongod.stop(); } catch {}
  process.exit(1);
});
