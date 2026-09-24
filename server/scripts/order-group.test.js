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

  // ---------------------------------------------------------------- 3 ------
  head('3 — הזמנת סניף להצטרף');
  let groupSeedId, invitedId, groupId;
  {
    const seed = await invoke(c.create, {
      user: userA, branchScope: scopeA,
      body: { branch_id: String(branchA._id), supplier_id: sid, hold: true, items: [item('שמן', 10, 30)] },
    });
    groupSeedId = String(seed.body.order.id);

    const r = await invoke(c.invite, { user: userA, branchScope: scopeA, params: { id: groupSeedId }, body: { branch_id: String(branchB._id) } });
    eq(r.status, 201, '3a נוצרה טיוטה לסניף ב');
    eq(r.body.order.status, 'draft', '3b במצב draft');
    eq(String(r.body.order.branch_id), String(branchB._id), '3c של סניף ב');
    eq(r.body.order.items.length, 0, '3d ריקה');
    eq(r.body.order.group_invited_by, 'מנהלת א', '3e יודעת מי הזמין');
    invitedId = String(r.body.order.id);
    groupId = String(r.body.order.group_id);
    const seedDb = await Order.findById(groupSeedId).lean();
    eq(String(seedDb.group_id), groupId, '3f המקור קיבל את אותו group_id');

    const events = await NotificationEvent.find({ type: 'order_shared', ref_id: invitedId }).lean();
    eq(events.length, 1, '3g התראה אחת למנהלת סניף ב');
    eq(String(events[0].recipient_id), String(managerB._id), '3h לנמענת הנכונה');
    eq(events[0].url, `/orders/${invitedId}/edit`, '3i הקישור פותח את הטיוטה לעריכה');
  }

  // ---------------------------------------------------------------- 4 ------
  head('4 — אותו סניף פעמיים');
  {
    const r = await invoke(c.invite, { user: userA, branchScope: scopeA, params: { id: groupSeedId }, body: { branch_id: String(branchB._id) } });
    eq(r.status, 400, '4a נדחה');
    const r2 = await invoke(c.invite, { user: userA, branchScope: scopeA, params: { id: groupSeedId }, body: { branch_id: String(branchA._id) } });
    eq(r2.status, 400, '4b וגם את הסניף של עצמו אי אפשר');
    const inv = await invoke(c.invitableBranches, { user: userA, branchScope: scopeA, params: { id: groupSeedId } });
    eq(inv.body.branches.map(b => b.name), ['סניף ג'], '4c רק סניף ג נותר להזמנה');
  }

  // ---------------------------------------------------------------- 3z -----
  head('3z — שליחה מטיוטה ריקה של סניף שהצטרף לא מחזירה הזמנה של סניף אחר');
  {
    const seed2 = await invoke(c.create, {
      user: userA, branchScope: scopeA,
      body: { branch_id: String(branchA._id), supplier_id: sid, hold: true, items: [item('שמן', 50, 30)] },
    });
    const group2SeedId = String(seed2.body.order.id);

    const inv2 = await invoke(c.invite, { user: userA, branchScope: scopeA, params: { id: group2SeedId }, body: { branch_id: String(branchC._id) } });
    const group2InvitedId = String(inv2.body.order.id);

    const r = await invoke(c.send, { user: adminUser, branchScope: null, params: { id: group2InvitedId } });
    eq(r.status, 200, '3z-a נשלחה בהצלחה');
    eq(r.body.sent_count, 1, '3z-b נשלחה רק ההזמנה עם הפריטים');
    eq(r.body.order.status, 'cancelled', '3z-c ההזמנה המוחזרת היא של הקוראת — בוטלה');
    eq(String(r.body.order.id), group2InvitedId, '3z-d ולא הזמנה של סניף אחר');
  }

  // ---------------------------------------------------------------- 8 ------
  head('8 — סיכום הקבוצה: רואים סכומים, לא פריטים');
  {
    const r = await invoke(c.group, { user: userB, branchScope: scopeB, params: { id: invitedId } });
    eq(r.status, 200, '8a סניף ב רואה את הקבוצה');
    eq(r.body.members.length, 2, '8b שני חברים');
    const a = r.body.members.find(m => m.branch_name === 'סניף א');
    eq(a.items_count, 1, '8c מספר הפריטים של סניף א');
    eq(a.total_amount, 300, '8d והסכום');
    eq(a.is_mine, false, '8e אבל לא שלו');
    eq(a.items, undefined, '8f ובלי הפריטים עצמם');
    eq(r.body.supplier.min_order_amount, 1200, '8g המינימום של הספק');
    eq(r.body.total_with_items, 300, '8h הסכום המשותף');

    const stranger = await invoke(c.group, { user: userA, branchScope: [String(branchC._id)], params: { id: invitedId } });
    eq(stranger.status, 403, '8i מי שאינו בשום חברה — 403');
  }

  // ---------------------------------------------------------------- 9 ------
  head('9 — ההתראה נסגרת כשהסניף שמר פריטים');
  {
    const r = await invoke(c.update, { user: userB, branchScope: scopeB, params: { id: invitedId }, body: { items: [item('קמח', 50, 20)] } });
    eq(r.status, 200, '9a נשמר');
    const ev = await NotificationEvent.findOne({ type: 'order_shared', ref_id: invitedId }).lean();
    eq(ev.status, 'resolved', '9b ההתראה נסגרה');
  }

  // ---------------------------------------------------------------- 5 ------
  head('5 — שליחה משותפת: מייל אחד, קובץ לכל סניף, הריק מבוטל');
  {
    // Third branch invited and never adds anything.
    const inv = await invoke(c.invite, { user: userA, branchScope: scopeA, params: { id: groupSeedId }, body: { branch_id: String(branchC._id) } });
    const emptyId = String(inv.body.order.id);

    // A (300) + B (1000) = 1300 ≥ 1200, though neither alone reaches it.
    sentMail.length = 0;
    const r = await invoke(c.send, { user: userB, branchScope: scopeB, params: { id: invitedId } });
    eq(r.status, 200, '5a נשלחה');
    eq(r.body.sent_count, 2, '5b שתי הזמנות נשלחו');
    eq(sentMail.length, 1, '5c מייל אחד');
    eq(sentMail[0].kind, 'group', '5d המייל הקבוצתי');
    eq(sentMail[0].orders.length, 2, '5e עם שתי ההזמנות');
    const names = sentMail[0].orders.map(o => o.branch.name).sort();
    eq(names, ['סניף א', 'סניף ב'], '5f כל אחת עם הסניף שלה');

    const a = await Order.findById(groupSeedId).lean();
    const b = await Order.findById(invitedId).lean();
    const e = await Order.findById(emptyId).lean();
    eq([a.status, b.status], ['pending', 'pending'], '5g שתיהן pending');
    eq([a.email_status, b.email_status], ['sent', 'sent'], '5h שתיהן רשמו שהמייל נשלח');
    eq(a.email_message_id, b.email_message_id, '5i אותו מזהה הודעה');
    eq(e.status, 'cancelled', '5j הריקה בוטלה');
    ok(/לא הוסיף פריטים/.test(e.notes), '5k עם הסיבה בהערות');
    const evB = await NotificationEvent.find({ ref_id: invitedId, status: 'pending' }).lean();
    eq(evB.length, 0, '5l אין התראות פתוחות על הקבוצה');
  }

  // ---------------------------------------------------------------- 6 ------
  head('6 — מינימום על הסכום המשותף');
  {
    const seed = await invoke(c.create, {
      user: userA, branchScope: scopeA,
      body: { branch_id: String(branchA._id), supplier_id: sid, hold: true, items: [item('אורז', 10, 50)] },
    });
    const sId = String(seed.body.order.id);
    const inv = await invoke(c.invite, { user: userA, branchScope: scopeA, params: { id: sId }, body: { branch_id: String(branchB._id) } });
    const bId = String(inv.body.order.id);
    await invoke(c.update, { user: userB, branchScope: scopeB, params: { id: bId }, body: { items: [item('סוכר', 10, 40)] } });

    sentMail.length = 0;
    const r = await invoke(c.send, { user: userA, branchScope: scopeA, params: { id: sId } });
    eq(r.status, 400, '6a 500 + 400 = 900 < 1200 — נדחה');
    ok(/חסרים 300/.test(r.body.error), '6b ואומר כמה חסר');
    eq(sentMail.length, 0, '6c בלי מייל');
    const still = await Order.findById(sId).lean();
    eq(still.status, 'draft', '6d ההזמנה נשארה בהמתנה');
  }

  // ---------------------------------------------------------------- 5x ----
  head('5x — המייל הקבוצתי האמיתי בונה קובץ לכל סניף');
  {
    // The real function, with dispatchEmail stubbed.
    delete require.cache[emailPath];
    const realEmail = require('../src/services/email.service');
    const dispatched = [];
    const origDispatch = realEmail.dispatchEmail;
    // sendGroupOrderEmail must call through module.exports.dispatchEmail so it can be observed.
    realEmail.dispatchEmail = async (m) => { dispatched.push(m); return { messageId: '<g@test>', provider: 'test' }; };
    process.env.RESEND_API_KEY = 'test';
    const env = require('../src/config/env');
    env.RESEND_API_KEY = 'test';

    const oa = { order_number: 'ORD-A', items: [{ name: 'שמן', qty: 10, unit_price: 30, total: 300 }], total_amount: 300, notes: '' };
    const ob = { order_number: 'ORD-B', items: [{ name: 'קמח', qty: 50, unit_price: 20, total: 1000 }], total_amount: 1000, notes: '' };
    const result = await realEmail.sendGroupOrderEmail({
      orders: [{ order: oa, branch: { name: 'סניף א', address: 'רחוב א 1' } }, { order: ob, branch: { name: 'סניף ב', address: 'רחוב ב 2' } }],
      supplier: { name: 'שאבי', contact_email: 's@x.co.il' }, creatorEmail: 'a@gan.co.il', creatorName: 'מנהלת א',
    });
    eq(result.sent, true, '5x-a הוחזר sent');
    eq(dispatched.length, 1, '5x-b מייל אחד');
    eq(dispatched[0].attachments.length, 4, '5x-c ארבעה קבצים — ספק+פנימי לכל סניף');
    ok(/הזמנה משותפת/.test(dispatched[0].subject), '5x-d הנושא אומר משותפת');
    ok(/סניף א/.test(dispatched[0].subject) && /סניף ב/.test(dispatched[0].subject), '5x-e ושני הסניפים בנושא');
    ok(/רחוב א 1/.test(dispatched[0].html) && /רחוב ב 2/.test(dispatched[0].html), '5x-f שתי הכתובות בגוף');
    realEmail.dispatchEmail = origDispatch;
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
