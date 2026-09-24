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

  // ---------------------------------------------------------------- 1 ------
  head('1 — שמירה בהמתנה: טיוטה, בלי מייל');
  let heldId;
  {
    sentMail.length = 0;
    const r = await invoke(c.create, {
      user: userA, branchScope: scopeA,
      body: { branch_id: String(branchA._id), supplier_id: sid, hold: true, items: [item('ממרח תמרים', 400, 4.13)] },
    });
    eq(r.status, 201, '1a נוצרה');
    eq(r.body.order.status, 'draft', '1b במצב draft');
    eq(r.body.order.email_status, 'never', '1c לא נשלח מייל — email_status נשאר never');
    eq(sentMail.length, 0, '1d השולח לא נקרא');
    eq(r.body.order.sent_at, null, '1e sent_at ריק');
    heldId = String(r.body.order.id);
  }

  head('1x — בלי hold: כמו היום, pending + מייל');
  {
    sentMail.length = 0;
    const r = await invoke(c.create, {
      user: userA, branchScope: scopeA,
      body: { branch_id: String(branchA._id), supplier_id: sid, items: [item('לחם', 200, 8)] },
    });
    eq(r.status, 201, '1f נוצרה');
    eq(r.body.order.status, 'pending', '1g pending');
    eq(r.body.order.email_status, 'sent', '1h המייל נשלח');
    eq(sentMail.length, 1, '1i בדיוק שולח אחד');
    eq(sentMail[0].kind, 'single', '1j הזמנה בודדת — המייל הרגיל');
    ok(r.body.order.sent_at, '1k sent_at נרשם');
    eq(r.body.order.sent_by, 'מנהלת א', '1l sent_by הוא מי שלחץ');
  }

  head('1m — מתחת למינימום בלי hold — נדחה');
  {
    sentMail.length = 0;
    const r = await invoke(c.create, {
      user: userA, branchScope: scopeA,
      body: { branch_id: String(branchA._id), supplier_id: sid, items: [item('לחם', 10, 8)] },
    });
    eq(r.status, 400, '1m מתחת למינימום בלי hold — נדחה');
    eq(sentMail.length, 0, '1n ובלי מייל');
  }

  // ---------------------------------------------------------------- 2 ------
  head('2 — שליחת טיוטה בודדת');
  {
    sentMail.length = 0;
    const r = await invoke(c.send, { user: userA, branchScope: scopeA, params: { id: heldId } });
    eq(r.status, 200, '2a נשלחה');
    eq(r.body.order.status, 'pending', '2b עכשיו pending');
    eq(r.body.order.email_status, 'sent', '2c המייל נשלח');
    eq(sentMail.length, 1, '2d מייל אחד');
    ok(r.body.order.sent_at, '2e sent_at נרשם');
    const inDb = await Order.findById(heldId).lean();
    eq(inDb.status, 'pending', '2f וגם במסד');
  }

  // ---------------------------------------------------------------- 7 ------
  head('7 — שליחה פעמיים');
  {
    sentMail.length = 0;
    const r = await invoke(c.send, { user: userA, branchScope: scopeA, params: { id: heldId } });
    eq(r.status, 400, '7a השנייה נדחית');
    eq(sentMail.length, 0, '7b ובלי מייל נוסף');
  }

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
