# Order Hold & Group Orders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A supply order can be saved on hold (no email), sent later by anyone at the branch, and several branches can order together from one supplier in one email with one document per branch.

**Architecture:** The `Order` model stays the per-branch unit; a group is N draft orders sharing a `group_id`. Sending is extracted from `create` into one service (`order-dispatch.service.js`) that both `create` and the new `send` route call — a single order is a group of one. Nothing downstream (approve, arrive, receive, stock) changes.

**Tech Stack:** Node/Express + Mongoose (server), React + MUI (client), tests are plain `node scripts/*.test.js` with `mongodb-memory-server` and `require.cache` stubs.

**Spec:** `docs/superpowers/specs/2026-09-24-order-hold-and-group-design.md` (Hebrew — read it first).

## Global Constraints

- Repo root: `~/dev/gan-halomot`. Server code in `server/`, client in `client/`. Run server tests from `server/`: `node scripts/<name>.test.js`.
- No new hex colours in client code: `node scripts/design-hex-budget.test.js` must not report a HIGHER count than before your change (it already fails on main at "+8" — your job is to not add to it). Use theme tokens / MUI `color` props only.
- All user-facing strings in Hebrew. Status `draft` is labelled **בהמתנה** everywhere (not טיוטה).
- The existing button "שלח לאישור" becomes "שלח לספק".
- Commit messages: conventional prefix, English, end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Do NOT push; the user pushes.
- `dotenv` must be stubbed out of `require.cache` before any `src/` require in a test (copy the block from `scripts/supplier-catalogue.test.js` lines 26-30), and `email.service` must be stubbed so no mail leaves a test.
- Existing tests that must stay green: `scripts/order-delivery.test.js`, `scripts/supplier-catalogue.test.js`.

---

## File Structure

| File | Responsibility |
|---|---|
| `server/src/models/Order.js` | + `group_id`, `group_invited_by`, `sent_at`, `sent_by` |
| `server/src/models/NotificationEvent.js` | + enum value `order_shared` |
| `server/src/services/order-dispatch.service.js` (new) | `dispatchOrders(orders, { supplier, user })`: claim drafts → pending, email (single or group), record delivery on every member |
| `server/src/services/email.service.js` | + `sendGroupOrderEmail({ orders, supplier, creatorEmail, creatorName })` |
| `server/src/controllers/order.controller.js` | `create` uses `hold`; new `send`, `invite`, `group`, `invitableBranches`; `update` resolves the invite notification; `remove` resolves it too |
| `server/src/routes/order.routes.js` | new routes |
| `server/scripts/order-group.test.js` (new) | the 9 spec tests |
| `server/package.json` | `test:order-group` script |
| `client/src/components/orders/OrderGroupPanel.jsx` (new) | fetches `/orders/:id/group`, renders members + total vs minimum |
| `client/src/components/orders/InviteBranchDialog.jsx` (new) | picks a branch from `/orders/:id/invitable-branches`, POSTs invite |
| `client/src/components/orders/OrderForm.jsx` | two buttons; edit-draft mode; group panel |
| `client/src/components/orders/OrderView.jsx` | draft actions (send / edit / invite / delete), group panel, invited banner |
| `client/src/components/orders/OrderList.jsx` | label בהמתנה, group chip |

---

### Task 1: Model fields + test harness skeleton

**Files:**
- Modify: `server/src/models/Order.js` (after `received_by_name`)
- Modify: `server/src/models/NotificationEvent.js` (enum)
- Create: `server/scripts/order-group.test.js`
- Modify: `server/package.json` (scripts)

**Interfaces:**
- Produces: `Order.group_id: ObjectId|null`, `Order.group_invited_by: String`, `Order.sent_at: Date|null`, `Order.sent_by: String`; `NotificationEvent.type` accepts `'order_shared'`.

- [ ] **Step 1: Write the test harness with the first (model) check**

Create `server/scripts/order-group.test.js`:

```js
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
```

Note: check `server/src/models/User.js` for the required fields on `User.create` (the model requires `email`; if `password_hash` is named differently, e.g. `password`, use the real field name — read the schema lines 1-60).

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && node scripts/order-group.test.js`
Expected: `0a`–`0d` fail (fields undefined) and `0e` fails (enum rejects `order_shared`).

- [ ] **Step 3: Add the fields and the enum value**

In `server/src/models/Order.js`, after `received_by_name: { type: String, default: '' },` add:

```js
  /**
   * Several branches ordering together from one supplier. A group is N draft
   * orders sharing this id — one per branch, each with its own items, its own
   * delivery address and its own stock receive. null = an order on its own.
   */
  group_id: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
  /** Who invited this branch into the group (empty when the branch started it). */
  group_invited_by: { type: String, default: '' },
  /**
   * When the supplier was written to. Orders from before this field carry null
   * and their created_at IS the send time — creation used to send on the spot.
   */
  sent_at: { type: Date, default: null },
  sent_by: { type: String, default: '' },
```

In `server/src/models/NotificationEvent.js`, inside the `enum: [ ... ]` array after `'child_moved',` add:

```js
      // A branch was invited into a joint supply order; its manager adds items.
      'order_shared',
```

Also extend the comment on `ref_collection` to include `'Order'`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && node scripts/order-group.test.js`
Expected: `0a`–`0e` pass, `🎉 5/5 עברו`.

- [ ] **Step 5: Register the npm script and commit**

In `server/package.json` scripts, next to `"test:order-delivery"`, add:

```json
    "test:order-group": "node scripts/order-group.test.js",
```

```bash
cd ~/dev/gan-halomot
git add server/src/models/Order.js server/src/models/NotificationEvent.js server/scripts/order-group.test.js server/package.json
git commit -m "feat(orders): fields for an order that waits and for ordering together

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `dispatchOrders` service + `hold` on create + `send` for a single order

**Files:**
- Create: `server/src/services/order-dispatch.service.js`
- Modify: `server/src/controllers/order.controller.js` (`create`, new `send`, exports)
- Modify: `server/src/routes/order.routes.js`
- Test: `server/scripts/order-group.test.js` (sections 1, 2, 7)

**Interfaces:**
- Consumes: `sendOrderEmail` / `sendGroupOrderEmail` from `email.service` (group one is written in Task 4; until then the service only ever receives one order, and the test stub already provides both).
- Produces: `dispatchOrders(orderIds, { supplier, user }) → Promise<Order[]>` — claims each draft (`status: 'draft'` → `'pending'`, `sent_at`, `sent_by`), emails (one order → `sendOrderEmail`; several → `sendGroupOrderEmail`), writes the delivery patch on every claimed order, returns the fresh documents. Throws `Error` with `.status = 400` and a Hebrew `.message` when nothing could be claimed.
- Produces: `POST /orders/:id/send` (canOrder).

- [ ] **Step 1: Append the failing tests**

Replace the line `// __TASKS_APPEND_HERE__` in `order-group.test.js` with:

```js
  // ---------------------------------------------------------------- 1 ------
  head('1 — שמירה בהמתנה: טיוטה, בלי מייל');
  let heldId;
  {
    sentMail.length = 0;
    const r = await invoke(c.create, {
      user: userA, branchScope: scopeA,
      body: { branch_id: String(branchA._id), supplier_id: sid, hold: true, items: [item('ממרח תמרים', 24, 4.13)] },
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
      body: { branch_id: String(branchA._id), supplier_id: sid, items: [item('לחם', 10, 8)] },
    });
    eq(r.status, 201, '1f נוצרה');
    eq(r.body.order.status, 'pending', '1g pending');
    eq(r.body.order.email_status, 'sent', '1h המייל נשלח');
    eq(sentMail.length, 1, '1i בדיוק שולח אחד');
    eq(sentMail[0].kind, 'single', '1j הזמנה בודדת — המייל הרגיל');
    ok(r.body.order.sent_at, '1k sent_at נרשם');
    eq(r.body.order.sent_by, 'מנהלת א', '1l sent_by הוא מי שלחץ');
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && node scripts/order-group.test.js`
Expected: `1b` fails (status is `pending`), `1d` fails (mail sent), section 2 crashes or fails because `c.send` is undefined. (If the run throws on `c.send` before printing, that is the expected failure.)

- [ ] **Step 3: Write the dispatch service**

Create `server/src/services/order-dispatch.service.js`:

```js
/**
 * Sending an order to the supplier — one place, whether the order goes out the
 * moment it is created, is sent later from a draft, or goes out together with
 * the drafts of other branches.
 *
 * Before this, the send lived inside the create handler: email the supplier,
 * then write what happened onto the order. A draft that is sent later needs
 * exactly the same thing, and a group needs it for N orders at once with one
 * email. So it is one function, and a single order is a group of one.
 *
 * The claim comes first. `status: 'draft'` → `'pending'` is written with a
 * condition on the current status, so two managers clicking "send" on the
 * same group at the same moment cannot both win: the second finds nothing to
 * claim and is told so. Only the orders actually claimed are emailed.
 */
const { Order, Branch } = require('../models');
const { sendOrderEmail, sendGroupOrderEmail } = require('./email.service');
const { deliveryFromResult, deliveryFromError } = require('./order-delivery.service');

function creatorEmailOf(user) {
  const email = user?.email;
  if (!email) return null;
  return String(email).endsWith('@gan-halomot.local') ? null : email;
}

/**
 * @param {Array<string|import('mongoose').Types.ObjectId>} orderIds  drafts to send, all for `supplier`
 * @param {{ supplier: object, user: object }} ctx
 * @returns {Promise<object[]>} the sent orders, fresh from the database (plain objects with `id`)
 */
async function dispatchOrders(orderIds, { supplier, user }) {
  const ids = orderIds.map(String);
  const now = new Date();
  const sentBy = user?.full_name || '';

  // Claim. Whoever's update matches is the one who sends.
  const claim = await Order.updateMany(
    { _id: { $in: ids }, status: 'draft' },
    { $set: { status: 'pending', sent_at: now, sent_by: sentBy } }
  );
  if (!claim.modifiedCount) {
    const err = new Error('ההזמנה כבר נשלחה');
    err.status = 400;
    throw err;
  }

  const orders = await Order.find({ _id: { $in: ids }, sent_at: now }).lean();
  const branchIds = [...new Set(orders.map(o => String(o.branch_id)))];
  const branches = await Branch.find({ _id: { $in: branchIds } })
    .select('name address delivery_contact_name delivery_contact_phone').lean();
  const branchById = new Map(branches.map(b => [String(b._id), b]));

  const creatorEmail = creatorEmailOf(user);
  const creatorName = sentBy;
  const supplierObj = supplier?.toObject ? supplier.toObject() : supplier;

  let delivery;
  try {
    let result;
    if (orders.length === 1) {
      result = await sendOrderEmail({
        order: orders[0], supplier: supplierObj, branch: branchById.get(String(orders[0].branch_id)) || null,
        creatorEmail, creatorName,
      });
    } else {
      result = await sendGroupOrderEmail({
        orders: orders.map(o => ({ order: o, branch: branchById.get(String(o.branch_id)) || null })),
        supplier: supplierObj, creatorEmail, creatorName,
      });
    }
    delivery = deliveryFromResult(result);
  } catch (mailErr) {
    console.error('Order email failed:', mailErr.message);
    delivery = deliveryFromError(mailErr);
  }

  // Recording the outcome must not be able to undo the send.
  try {
    await Order.updateMany({ _id: { $in: orders.map(o => o._id) } }, { $set: delivery });
  } catch (writeErr) {
    console.error('Order email status write failed:', writeErr.message);
  }

  const fresh = await Order.find({ _id: { $in: orders.map(o => o._id) } }).lean();
  return fresh.map(o => ({ ...o, id: o._id }));
}

module.exports = { dispatchOrders };
```

- [ ] **Step 4: Rewrite `create` to use it, add `send`**

In `server/src/controllers/order.controller.js`:

At the top, replace
```js
const { sendOrderEmail } = require('../services/email.service');
const { deliveryFromResult, deliveryFromError } = require('../services/order-delivery.service');
```
with
```js
const { sendOrderEmail } = require('../services/email.service');
const { deliveryFromResult, deliveryFromError } = require('../services/order-delivery.service');
const { dispatchOrders } = require('../services/order-dispatch.service');
```
(`sendOrderEmail` / `deliveryFrom*` are still used by `resendEmail`.)

Replace the body of `create` from `const order = await Order.create({` through `res.status(201).json({ order: { ...order.toObject(), id: order._id } });` with:

```js
    const order = await Order.create({
      order_number, branch_id, supplier_id,
      items: processedItems, total_amount,
      notes: notes || '', created_by: created_by || req.user?.full_name || '',
      // Every order is born a draft. Without `hold` it is sent in the same
      // breath — which is what "create" always did, now through the one
      // function that sending later and sending together also use.
      status: 'draft',
    });

    if (req.body.hold) {
      return res.status(201).json({ order: { ...order.toObject(), id: order._id } });
    }

    const [sent] = await dispatchOrders([order._id], { supplier, user: req.user });
    res.status(201).json({ order: sent });
```

Add a new handler after `update`:

```js
/**
 * Send a draft to the supplier. If the draft belongs to a group, every draft
 * in the group with items goes out in one email; a member that never added
 * anything is cancelled rather than sent empty.
 */
async function send(req, res, next) {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'הזמנה לא נמצאה' });
    if (order.status !== 'draft') return res.status(400).json({ error: 'ההזמנה כבר נשלחה' });

    const supplier = await Supplier.findById(order.supplier_id);
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });

    const members = order.group_id
      ? await Order.find({ group_id: order.group_id, status: 'draft' })
      : [order];
    const withItems = members.filter(m => (m.items || []).length > 0);
    const empty = members.filter(m => !(m.items || []).length);

    if (!withItems.length) return res.status(400).json({ error: 'אין פריטים לשליחה' });

    const groupTotal = withItems.reduce((s, m) => s + (m.total_amount || 0), 0);
    const minOrder = supplier.min_order_amount || 0;
    if (minOrder > 0 && groupTotal < minOrder) {
      return res.status(400).json({
        error: `מינימום הזמנה ${minOrder} ₪ — חסרים ${Number((minOrder - groupTotal).toFixed(2))} ₪`,
        group_total: groupTotal, min_order_amount: minOrder,
      });
    }

    if (empty.length) {
      await Order.updateMany(
        { _id: { $in: empty.map(m => m._id) }, status: 'draft' },
        { $set: { status: 'cancelled', notes: 'לא הוסיף פריטים — בוטל בשליחת ההזמנה המשותפת' } }
      );
    }

    let sent;
    try {
      sent = await dispatchOrders(withItems.map(m => m._id), { supplier, user: req.user });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      throw err;
    }

    const mine = sent.find(o => String(o._id) === String(order._id)) || sent[0];
    res.json({ order: mine, sent_count: sent.length });
  } catch (error) { next(error); }
}
```

Change the exports line to:
```js
module.exports = { getAll, getById, create, update, send, approve, markArrived, receive, resendEmail, remove };
```

In `server/src/routes/order.routes.js`, after `router.put('/:id', canOrder, c.update);` add:
```js
router.post('/:id/send', canOrder, c.send);
```

- [ ] **Step 5: Run the tests**

Run: `cd server && node scripts/order-group.test.js && node scripts/supplier-catalogue.test.js && node scripts/order-delivery.test.js`
Expected: all sections pass in all three files. If `supplier-catalogue.test.js` asserts on an order created through `create`, its expectations still hold (status `pending`, email fields written) because `dispatchOrders` writes the same patch.

- [ ] **Step 6: Commit**

```bash
cd ~/dev/gan-halomot
git add server/src/services/order-dispatch.service.js server/src/controllers/order.controller.js server/src/routes/order.routes.js server/scripts/order-group.test.js
git commit -m "feat(orders): an order can wait — hold on create, send later, one dispatch path

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `invite`, `group` summary, `invitable-branches`, notification lifecycle

**Files:**
- Modify: `server/src/controllers/order.controller.js` (new `invite`, `group`, `invitableBranches`; `update` and `remove` resolve events)
- Modify: `server/src/routes/order.routes.js`
- Test: `server/scripts/order-group.test.js` (sections 3, 4, 8, 9)

**Interfaces:**
- Consumes: `createEvent`, `resolveEvents`, `branchManagerIds` from `server/src/services/notification.service.js` (signatures: `createEvent({ type, ref_collection, ref_id, recipient_id, title, body, url })`, `resolveEvents({ ref_collection, ref_id })`, `branchManagerIds(branchId) → string[]`).
- Produces: `POST /orders/:id/invite { branch_id }` → `201 { order: <new draft> }`; `GET /orders/:id/group` → `{ group_id, supplier: { name, min_order_amount }, members: [{ id, branch_id, branch_name, items_count, total_amount, status, invited_by, is_mine }], total_with_items }`; `GET /orders/:id/invitable-branches` → `{ branches: [{ id, name }] }`.

- [ ] **Step 1: Append the failing tests**

Replace `// __TASKS_APPEND_HERE__` with:

```js
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

  // __TASKS_APPEND_HERE__
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && node scripts/order-group.test.js`
Expected: crash/failure at section 3 — `c.invite` is not a function.

- [ ] **Step 3: Implement the three handlers and the resolve hooks**

In `order.controller.js` add to the requires at the top:
```js
const { createEvent, resolveEvents, branchManagerIds } = require('../services/notification.service');
```

Add a helper near `withStandingNotes`:

```js
/** Which of these branch ids the caller may see. null scope = all of them. */
function branchesInScope(req, branchIds) {
  const scope = req.branchScope;
  if (scope === null || scope === undefined && ['system_admin', 'accountant'].includes(req.user?.role)) return branchIds.map(String);
  const allowed = new Set((Array.isArray(scope) ? scope : []).map(String));
  return branchIds.map(String).filter(id => allowed.has(id));
}
```

Add the handlers after `send`:

```js
/**
 * Invite another branch into this draft. The branch gets an empty draft of its
 * own with the same supplier, both drafts share a group_id, and the branch's
 * managers are told.
 */
async function invite(req, res, next) {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'הזמנה לא נמצאה' });
    if (order.status !== 'draft') return res.status(400).json({ error: 'אפשר להזמין סניף רק להזמנה בהמתנה' });

    const { branch_id } = req.body;
    if (!branch_id) return res.status(400).json({ error: 'branch_id is required' });
    if (String(branch_id) === String(order.branch_id)) return res.status(400).json({ error: 'הסניף כבר בהזמנה' });

    const branch = await Branch.findOne({ _id: branch_id, is_active: true }).select('name').lean();
    if (!branch) return res.status(400).json({ error: 'סניף לא פעיל או לא קיים' });

    const groupId = order.group_id || new mongoose.Types.ObjectId();
    const already = await Order.exists({ group_id: groupId, branch_id, status: { $ne: 'cancelled' } });
    if (already) return res.status(400).json({ error: 'הסניף כבר בהזמנה המשותפת' });

    if (!order.group_id) {
      order.group_id = groupId;
      await order.save();
    }

    const supplier = await Supplier.findById(order.supplier_id).select('name').lean();
    const inviterBranch = await Branch.findById(order.branch_id).select('name').lean();
    const inviterName = req.user?.full_name || '';

    const created = await Order.create({
      order_number: 'ORD-' + Date.now(),
      branch_id, supplier_id: order.supplier_id,
      items: [], total_amount: 0, notes: '',
      created_by: '', status: 'draft',
      group_id: groupId, group_invited_by: inviterName,
    });

    const recipients = await branchManagerIds(branch_id);
    await Promise.all(recipients.map(recipient_id => createEvent({
      type: 'order_shared', ref_collection: 'Order', ref_id: created._id, recipient_id,
      title: `הזמנה משותפת מ${supplier?.name || 'ספק'}`,
      body: `${inviterName || 'מנהל/ת'} מסניף ${inviterBranch?.name || ''} מזמין/ה אתכם להצטרף להזמנה. הוסיפו פריטים ושלחו יחד.`,
      url: `/orders/${created._id}/edit`,
    })));

    res.status(201).json({ order: { ...created.toObject(), id: created._id } });
  } catch (error) { next(error); }
}

/** Every member of the group, as numbers — never as items. */
async function group(req, res, next) {
  try {
    const order = await Order.findById(req.params.id).select('group_id supplier_id branch_id').lean();
    if (!order) return res.status(404).json({ error: 'הזמנה לא נמצאה' });

    const members = order.group_id
      ? await Order.find({ group_id: order.group_id }).populate('branch_id', 'name').sort({ created_at: 1 }).lean()
      : await Order.find({ _id: order._id }).populate('branch_id', 'name').lean();

    const memberBranchIds = members.map(m => String(m.branch_id?._id || m.branch_id));
    const mine = new Set(branchesInScope(req, memberBranchIds));
    if (!mine.size) return res.status(403).json({ error: 'אין הרשאה להזמנה זו' });

    const supplier = await Supplier.findById(order.supplier_id).select('name min_order_amount').lean();
    const rows = members.map(m => ({
      id: m._id,
      branch_id: m.branch_id?._id || m.branch_id,
      branch_name: m.branch_id?.name || '',
      items_count: (m.items || []).length,
      total_amount: m.total_amount || 0,
      status: m.status,
      invited_by: m.group_invited_by || '',
      is_mine: mine.has(String(m.branch_id?._id || m.branch_id)),
    }));
    const total_with_items = rows
      .filter(r => r.items_count > 0 && r.status !== 'cancelled')
      .reduce((s, r) => s + r.total_amount, 0);

    res.json({
      group_id: order.group_id || null,
      supplier: { name: supplier?.name || '', min_order_amount: supplier?.min_order_amount || 0 },
      members: rows,
      total_with_items,
    });
  } catch (error) { next(error); }
}

/** Active branches not yet in this order's group — what the invite dialog lists. */
async function invitableBranches(req, res, next) {
  try {
    const order = await Order.findById(req.params.id).select('group_id branch_id').lean();
    if (!order) return res.status(404).json({ error: 'הזמנה לא נמצאה' });
    const taken = new Set([String(order.branch_id)]);
    if (order.group_id) {
      const members = await Order.find({ group_id: order.group_id, status: { $ne: 'cancelled' } }).select('branch_id').lean();
      members.forEach(m => taken.add(String(m.branch_id)));
    }
    const branches = await Branch.find({ is_active: true }).select('name').sort({ name: 1 }).lean();
    res.json({ branches: branches.filter(b => !taken.has(String(b._id))).map(b => ({ id: b._id, name: b.name })) });
  } catch (error) { next(error); }
}
```

`mongoose` must be required at the top of the controller: `const mongoose = require('mongoose');`.

In `update`, after `await order.save();` add:
```js
    // An invited branch that has now added items has answered the invitation.
    if (order.status === 'draft' && order.group_invited_by && (order.items || []).length) {
      await resolveEvents({ ref_collection: 'Order', ref_id: order._id });
    }
```

In `remove`, after `order.status = 'cancelled';` (and its save) add:
```js
    await resolveEvents({ ref_collection: 'Order', ref_id: order._id });
```

In `send`, right after the `dispatchOrders` call succeeds, add:
```js
    await Promise.all(members.map(m => resolveEvents({ ref_collection: 'Order', ref_id: m._id })));
```

Exports:
```js
module.exports = { getAll, getById, create, update, send, invite, group, invitableBranches, approve, markArrived, receive, resendEmail, remove };
```

Routes (`order.routes.js`) — these must come BEFORE `router.get('/:id', c.getById)`:
```js
router.get('/:id/group', c.group);
router.get('/:id/invitable-branches', canOrder, c.invitableBranches);
router.post('/:id/invite', canOrder, c.invite);
```
(`/:id/group` still matches `/:id` first if placed after it — Express matches `/:id` only for a single segment, so ordering is fine either way, but keep them grouped above for clarity.)

- [ ] **Step 4: Run the tests**

Run: `cd server && node scripts/order-group.test.js`
Expected: sections 0–4, 7, 8, 9 pass. Note: `branchManagerIds` falls back to all system_admins when a branch has no manager — `managerB` exists so `3g` expects exactly one event. If `3g` reports 2, check `branch-recipients.service` `branchManagerClauses` for what it requires on the user (e.g. `managed_branch_ids` membership) and adjust the `User.create` in the harness, not the service.

- [ ] **Step 5: Commit**

```bash
cd ~/dev/gan-halomot
git add server/src/controllers/order.controller.js server/src/routes/order.routes.js server/scripts/order-group.test.js
git commit -m "feat(orders): invite a branch into a draft, see the group as numbers, tell its manager

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Group email + group send with minimum on the joint total

**Files:**
- Modify: `server/src/services/email.service.js` (new `sendGroupOrderEmail`, export it)
- Test: `server/scripts/order-group.test.js` (sections 5, 6)

**Interfaces:**
- Consumes: `buildSupplierHTML({ order, supplier, branch })`, `buildInternalHTML(...)`, `buildFilename({ variant, branch, order })` from `order-pdf.service.js`; `dispatchEmail({ to, cc, subject, html, attachments })`.
- Produces: `sendGroupOrderEmail({ orders: [{ order, branch }], supplier, creatorEmail, creatorName }) → { sent, messageId, provider, recipients } | { skipped, reason }` — same shapes as `sendOrderEmail`.

- [ ] **Step 1: Append the failing tests**

Replace `// __TASKS_APPEND_HERE__` with:

```js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && node scripts/order-group.test.js`
Expected: sections 5 and 6 pass or fail depending on Task 2/3 (5 should already pass through the stub); `5x` fails — `realEmail.sendGroupOrderEmail is not a function`.

- [ ] **Step 3: Write `sendGroupOrderEmail`**

In `server/src/services/email.service.js`, after `sendOrderEmail` add:

```js
/**
 * Several branches' orders to one supplier, in one email.
 *
 * The supplier delivers to each branch separately, so each branch keeps its
 * own document — the same two files a single order sends, once per branch —
 * and the body lists every branch with its address so the driver's sheet and
 * the email agree. The joint total is what let the order pass the supplier's
 * minimum; it is stated once at the top.
 *
 * Returns the same shapes as sendOrderEmail, so order-delivery.service reads
 * it the same way and the delivery patch is written on every member.
 */
async function sendGroupOrderEmail({ orders, supplier, creatorEmail, creatorName }) {
  if (!env.GAS_EMAIL_URL && !env.RESEND_API_KEY && !env.SMTP_USER) {
    console.warn('No email provider configured — skipping group order email');
    return { skipped: true, reason: 'provider-not-configured' };
  }
  const supplierEmail = supplier?.contact_email;
  const officeEmail = 'dreamgan10@gmail.com';
  const recipients = [supplierEmail, creatorEmail, officeEmail].filter(Boolean);
  if (recipients.length === 0) return { skipped: true, reason: 'no-recipients' };

  const { buildSupplierHTML, buildInternalHTML, buildFilename } = require('./order-pdf.service');

  const branchNames = orders.map(({ branch }) => branch?.name || '').filter(Boolean);
  const numbers = orders.map(({ order }) => order.order_number).join(', ');
  const total = orders.reduce((s, { order }) => s + (order.total_amount || 0), 0);
  const fmt = (n) => Number(n || 0).toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const perBranch = orders.map(({ order, branch }) => `
      <div style="border:1px solid #cbd5e1; border-radius:8px; padding:12px; margin-bottom:12px;">
        <div style="font-weight:800; font-size:15px;">${branch?.name || ''} — הזמנה #${order.order_number}</div>
        ${branch?.address ? `<div><b>כתובת למשלוח:</b> ${branch.address}</div>` : ''}
        ${branch?.delivery_contact_name ? `<div><b>איש קשר:</b> ${branch.delivery_contact_name} ${branch.delivery_contact_phone || ''}</div>` : ''}
        <div><b>פריטים:</b> ${(order.items || []).length} · <b>סה"כ:</b> ${fmt(order.total_amount)} ₪</div>
        ${order.notes ? `<div style="margin-top:6px;"><b>הערות:</b> ${order.notes}</div>` : ''}
      </div>`).join('');

  const html = `
    <div dir="rtl" style="font-family: Arial, sans-serif; max-width:700px; margin:0 auto;">
      <h2 style="color:#10b981; border-bottom:3px solid #10b981; padding-bottom:8px;">הזמנה משותפת — ${branchNames.length} סניפים</h2>
      <p><b>ספק:</b> ${supplier?.name || ''}</p>
      <p><b>סה"כ משותף:</b> ${fmt(total)} ₪</p>
      <p style="color:#475569;">המשלוח לכל סניף בנפרד, לכתובת הרשומה לידו. לכל סניף מצורף קובץ הזמנה משלו.</p>
      ${perBranch}
      <p style="color:#94a3b8; font-size:12px;">נשלח על ידי ${creatorName || ''} ממערכת ההזמנות</p>
    </div>
  `;

  const cc = [creatorEmail, officeEmail].filter(e => e && e !== supplierEmail);
  const attachments = orders.flatMap(({ order, branch }) => ([
    { name: buildFilename({ variant: 'supplier', branch, order }), html: buildSupplierHTML({ order, supplier, branch }) },
    { name: buildFilename({ variant: 'internal', branch, order }), html: buildInternalHTML({ order, supplier, branch }) },
  ]));

  const info = await module.exports.dispatchEmail({
    to: supplierEmail || creatorEmail || officeEmail,
    cc,
    subject: `הזמנה משותפת: ${branchNames.join(', ')} (הזמנות #${numbers})`,
    html,
    attachments,
  });

  return { sent: true, messageId: info.messageId, provider: info.provider, recipients };
}
```

Add `sendGroupOrderEmail` to `module.exports` at the bottom of the file. The call goes through `module.exports.dispatchEmail` (not the bare identifier) so the test can observe it.

- [ ] **Step 4: Run the tests**

Run: `cd server && node scripts/order-group.test.js && node scripts/email-astral.test.js`
Expected: every section passes; `email-astral` unaffected.

- [ ] **Step 5: Commit**

```bash
cd ~/dev/gan-halomot
git add server/src/services/email.service.js server/scripts/order-group.test.js
git commit -m "feat(orders): one email for a joint order, one document per branch, minimum on the joint total

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Client — group panel + invite dialog components

**Files:**
- Create: `client/src/components/orders/OrderGroupPanel.jsx`
- Create: `client/src/components/orders/InviteBranchDialog.jsx`

**Interfaces:**
- Consumes: `GET /orders/:id/group`, `GET /orders/:id/invitable-branches`, `POST /orders/:id/invite`.
- Produces: `<OrderGroupPanel orderId refreshKey onLoaded? />` renders nothing when the order has no group (unless `showSingle`); `<InviteBranchDialog open onClose orderId onInvited(order) />`.

- [ ] **Step 1: Write `OrderGroupPanel.jsx`**

```jsx
import { useEffect, useState } from 'react';
import { Box, Typography, Stack, Chip, Alert, LinearProgress } from '@mui/material';
import GroupsIcon from '@mui/icons-material/Groups';
import api from '../../api/client';
import { formatCurrencyExact } from '../../utils/hebrewYear';

/**
 * Who is ordering together, as numbers. Each branch sees the others' totals
 * and item counts — never their items — and the joint total against the
 * supplier's minimum, which is the reason the branches are ordering together.
 */
export default function OrderGroupPanel({ orderId, refreshKey = 0, onLoaded }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    if (!orderId) return;
    api.get(`/orders/${orderId}/group`)
      .then(res => { setData(res.data); onLoaded?.(res.data); })
      .catch(() => setData(null));
  }, [orderId, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data || !data.group_id) return null;

  const min = data.supplier?.min_order_amount || 0;
  const total = data.total_with_items || 0;
  const short = min > 0 && total < min;
  const pct = min > 0 ? Math.min(100, Math.round((total / min) * 100)) : 100;

  return (
    <Box sx={{ mb: 2, p: 1.5, borderRadius: 2, bgcolor: 'background.sunken' }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
        <GroupsIcon fontSize="small" color="primary" />
        <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>
          הזמנה משותפת · {data.members.length} סניפים
        </Typography>
      </Stack>
      <Stack spacing={0.5}>
        {data.members.map(m => (
          <Stack key={m.id} direction="row" justifyContent="space-between" alignItems="center">
            <Stack direction="row" spacing={0.75} alignItems="center">
              <Typography variant="body2" sx={{ fontWeight: m.is_mine ? 800 : 500 }}>{m.branch_name}</Typography>
              {m.is_mine && <Chip label="שלי" size="small" color="primary" variant="outlined" />}
              {m.status === 'cancelled' && <Chip label="בוטל" size="small" color="error" variant="outlined" />}
              {m.status === 'draft' && m.items_count === 0 && <Chip label="עדיין לא הוסיף" size="small" variant="outlined" />}
            </Stack>
            <Typography variant="body2" color="text.secondary">
              {m.items_count} פריטים · {formatCurrencyExact(m.total_amount)}
            </Typography>
          </Stack>
        ))}
      </Stack>
      {min > 0 && (
        <Box sx={{ mt: 1.5 }}>
          <Stack direction="row" justifyContent="space-between">
            <Typography variant="body2" sx={{ fontWeight: 700 }}>סה"כ משותף {formatCurrencyExact(total)}</Typography>
            <Typography variant="body2" color="text.secondary">מינימום {formatCurrencyExact(min)}</Typography>
          </Stack>
          <LinearProgress variant="determinate" value={pct} color={short ? 'warning' : 'success'} sx={{ mt: 0.5, borderRadius: 1 }} />
          {short && (
            <Alert severity="warning" sx={{ mt: 1, borderRadius: 2 }}>
              חסרים {formatCurrencyExact(min - total)} למינימום ההזמנה
            </Alert>
          )}
        </Box>
      )}
    </Box>
  );
}
```

`background.sunken` is already used in `QuoteImportDialog.jsx`, so it exists in the theme. If it does not resolve at runtime (renders transparent), use `'action.hover'` instead. No hex literals.

- [ ] **Step 2: Write `InviteBranchDialog.jsx`**

```jsx
import { useEffect, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, MenuItem, Typography,
} from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../api/client';

/** Pick a branch to order together with. Lists only branches not yet in the group. */
export default function InviteBranchDialog({ open, onClose, orderId, onInvited }) {
  const [branches, setBranches] = useState([]);
  const [branchId, setBranchId] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !orderId) return;
    setBranchId('');
    api.get(`/orders/${orderId}/invitable-branches`)
      .then(res => setBranches(res.data.branches || []))
      .catch(() => setBranches([]));
  }, [open, orderId]);

  const submit = async () => {
    if (!branchId) return toast.error('בחר סניף');
    setBusy(true);
    try {
      const res = await api.post(`/orders/${orderId}/invite`, { branch_id: branchId });
      toast.success('הסניף הוזמן — מנהל/ת הסניף קיבל/ה התראה');
      onInvited?.(res.data.order);
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בהזמנת סניף');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} dir="rtl" fullWidth maxWidth="xs">
      <DialogTitle sx={{ fontWeight: 700 }}>הזמן סניף להצטרף</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          הסניף יקבל טיוטה משלו עם אותו ספק, יוסיף את הפריטים שלו, וההזמנה תישלח לספק יחד — כל סניף עם המשלוח שלו.
        </Typography>
        {branches.length === 0 ? (
          <Typography variant="body2">אין סניפים נוספים להזמנה</Typography>
        ) : (
          <TextField select fullWidth size="small" label="סניף" value={branchId} onChange={e => setBranchId(e.target.value)}>
            {branches.map(b => <MenuItem key={b.id} value={b.id}>{b.name}</MenuItem>)}
          </TextField>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>ביטול</Button>
        <Button variant="contained" onClick={submit} disabled={busy || !branchId}>הזמן</Button>
      </DialogActions>
    </Dialog>
  );
}
```

- [ ] **Step 3: Build**

Run: `cd client && npm run build`
Expected: `✓ built` (the components are not yet imported anywhere, so this only checks syntax when they are — proceed; Task 6 wires them).

- [ ] **Step 4: Commit**

```bash
cd ~/dev/gan-halomot
git add client/src/components/orders/OrderGroupPanel.jsx client/src/components/orders/InviteBranchDialog.jsx
git commit -m "feat(orders): the group as a panel, and a dialog to invite a branch

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Client — OrderForm (two buttons, draft editing, group panel)

**Files:**
- Modify: `client/src/components/orders/OrderForm.jsx`

**Interfaces:**
- Consumes: `POST /orders { hold }`, `POST /orders/:id/send`, `<OrderGroupPanel />`.

- [ ] **Step 1: Track the loaded order's status and group**

In `OrderForm.jsx`, add state after `const [editSourceItems, setEditSourceItems] = useState(null);`:
```jsx
  const [editOrder, setEditOrder] = useState(null); // { status, group_id, group_invited_by } of the order being edited
  const [groupInfo, setGroupInfo] = useState(null);
```

In the edit-mode `useEffect`, after `setEditSourceItems(order.items || []);` add:
```jsx
        setEditOrder({ status: order.status, group_id: order.group_id || null, group_invited_by: order.group_invited_by || '' });
```

Add the import:
```jsx
import SaveIcon from '@mui/icons-material/Save';
import OrderGroupPanel from './OrderGroupPanel';
```

- [ ] **Step 2: Replace `handleSubmit` with a mode-aware version**

Replace the whole `handleSubmit` function with:

```jsx
  /**
   * mode: 'hold'  — new order, saved as a draft, no email
   *       'send'  — send to the supplier (new: create+send; draft: save then send)
   *       'save'  — edit only (draft or pending)
   */
  const handleSubmit = async (mode) => {
    if (!selectedSupplier) return toast.error('בחר ספק');
    if (cart.length === 0) return toast.error('הוסף מוצרים להזמנה');

    const isGroup = Boolean(editOrder?.group_id);
    const effectiveTotal = isGroup && groupInfo
      ? (groupInfo.members || []).filter(m => !m.is_mine && m.status !== 'cancelled').reduce((s, m) => s + m.total_amount, 0) + total
      : total;
    if (mode === 'send' && minOrder > 0 && effectiveTotal < minOrder) {
      return toast.error(`מינימום הזמנה: ${formatCurrency(minOrder)}${isGroup ? ' (על הסכום המשותף)' : ''}`);
    }

    setSaving(true);
    try {
      const items = cart.map(c => ({
        product_id: c.product._id || c.product.id,
        sku: c.product.sku,
        name: c.product.name,
        qty: c.qty,
        unit_price: c.product.price_with_vat,
      }));

      if (isEdit) {
        await api.put(`/orders/${editId}`, { items, notes });
        if (mode === 'send') {
          const res = await api.post(`/orders/${editId}/send`);
          const n = res.data.sent_count || 1;
          toast.success(n > 1 ? `ההזמנה נשלחה לספק — ${n} סניפים` : 'ההזמנה נשלחה לספק');
        } else {
          toast.success('ההזמנה עודכנה');
        }
        navigate(`/orders/${editId}`);
      } else {
        const res = await api.post('/orders', {
          branch_id: selectedBranch,
          supplier_id: selectedSupplier,
          items,
          notes,
          hold: mode === 'hold',
        });
        if (mode === 'hold') {
          toast.success('ההזמנה נשמרה בהמתנה');
          navigate(`/orders/${res.data.order.id || res.data.order._id}`);
        } else {
          toast.success('ההזמנה נשלחה לספק');
          navigate('/orders');
        }
      }
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בשמירה');
    } finally {
      setSaving(false);
    }
  };
```

- [ ] **Step 3: Replace the button block and add the panel**

Replace the single `<Button ... {saving ? 'שולח...' : 'שלח לאישור'} </Button>` block (the one with `startIcon={<SendIcon />}` at the bottom of the cart card) with:

```jsx
                    {(() => {
                      const isDraft = !isEdit || editOrder?.status === 'draft';
                      const isGroup = Boolean(editOrder?.group_id);
                      const memberCount = groupInfo?.members?.filter(m => m.status !== 'cancelled').length || 0;
                      const sendLabel = isGroup && memberCount > 1 ? `שלח לספק — כל הסניפים (${memberCount})` : 'שלח לספק';
                      const below = minOrder > 0 && total < minOrder && !isGroup;
                      return (
                        <Stack spacing={1}>
                          {isDraft && (
                            <Button
                              fullWidth variant="outlined" size="large"
                              startIcon={<SaveIcon />}
                              onClick={() => handleSubmit(isEdit ? 'save' : 'hold')}
                              disabled={saving}
                            >
                              {isEdit ? 'שמור' : 'שמור בהמתנה'}
                            </Button>
                          )}
                          {isDraft ? (
                            <Button
                              fullWidth variant="contained" size="large"
                              startIcon={<SendIcon />}
                              onClick={() => handleSubmit('send')}
                              disabled={saving || below}
                            >
                              {saving ? 'שולח...' : sendLabel}
                            </Button>
                          ) : (
                            <Button
                              fullWidth variant="contained" size="large"
                              startIcon={<SaveIcon />}
                              onClick={() => handleSubmit('save')}
                              disabled={saving}
                            >
                              {saving ? 'שומר...' : 'שמור שינויים'}
                            </Button>
                          )}
                        </Stack>
                      );
                    })()}
```

Above the `סל הזמנה` title (`<Typography variant="subtitle1" ... סל הזמנה`), insert:
```jsx
                {isEdit && editOrder?.group_id && (
                  <OrderGroupPanel orderId={editId} onLoaded={setGroupInfo} />
                )}
                {isEdit && editOrder?.group_invited_by && editOrder?.status === 'draft' && (
                  <Alert severity="info" sx={{ mb: 2, borderRadius: 2 }}>
                    הוזמנת להצטרף על ידי {editOrder.group_invited_by}. הוסיפו את הפריטים שלכם ושמרו.
                  </Alert>
                )}
```

Also change the minimum warning so it does not fire for a group member (the joint total decides): replace `{minOrder > 0 && total < minOrder && (` with `{minOrder > 0 && total < minOrder && !editOrder?.group_id && (`.

- [ ] **Step 4: Build and check the hex ratchet**

Run: `cd client && npm run build && cd ../server && node scripts/design-hex-budget.test.js | tail -2`
Expected: build ok; the ratchet's "עלה ב-N" is the same N as before your change (8 on main today) — you added no hex.

- [ ] **Step 5: Commit**

```bash
cd ~/dev/gan-halomot
git add client/src/components/orders/OrderForm.jsx
git commit -m "feat(orders): save on hold or send to the supplier — two buttons that say what they do

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Client — OrderView draft actions, OrderList label + chip

**Files:**
- Modify: `client/src/components/orders/OrderView.jsx`
- Modify: `client/src/components/orders/OrderList.jsx`

- [ ] **Step 1: OrderView — imports, state, handlers**

Add imports:
```jsx
import SendIcon from '@mui/icons-material/Send';
import GroupAddIcon from '@mui/icons-material/GroupAdd';
import OrderGroupPanel from './OrderGroupPanel';
import InviteBranchDialog from './InviteBranchDialog';
```

Change the `draft` entry of `STATUS_MAP` to `draft: { label: 'בהמתנה', color: 'default' },`.

Add state after `const [sendingEmail, setSendingEmail] = useState(false);`:
```jsx
  const [inviteOpen, setInviteOpen] = useState(false);
  const [groupKey, setGroupKey] = useState(0);
  const [sending, setSending] = useState(false);
```

Add handler after `handleCancel`:
```jsx
  const handleSend = async () => {
    setSending(true);
    try {
      const res = await api.post(`/orders/${id}/send`);
      const n = res.data.sent_count || 1;
      toast.success(n > 1 ? `נשלח לספק — ${n} סניפים` : 'נשלח לספק');
      setOrder(res.data.order);
      setGroupKey(k => k + 1);
      setConfirm({ open: false, action: '' });
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בשליחה');
    } finally {
      setSending(false);
    }
  };
```

- [ ] **Step 2: OrderView — render**

Under the header `Stack` (right after the closing `</Stack>` of the header block, before the `<Card>` with the details), insert:
```jsx
      {order.group_invited_by && order.status === 'draft' && (
        <Alert severity="info" sx={{ borderRadius: 2, mb: 2 }}>
          הוזמנת להצטרף על ידי {order.group_invited_by}. הוסיפו פריטים דרך "ערוך" ואז שלחו.
        </Alert>
      )}
      {order.group_id && <OrderGroupPanel orderId={id} refreshKey={groupKey} />}
```

Before the `{order.status === 'pending' && (` actions block, add the draft actions:
```jsx
      {order.status === 'draft' && (
        <Stack direction="row" spacing={2} flexWrap="wrap" gap={1}>
          <Button
            variant="contained" color="success" size="large"
            startIcon={<SendIcon />}
            onClick={() => setConfirm({ open: true, action: 'send' })}
            disabled={sending || !(order.items || []).length}
          >
            {order.group_id ? 'שלח לספק — כל הסניפים' : 'שלח לספק'}
          </Button>
          <Button
            variant="contained" color="primary" size="large"
            startIcon={<EditIcon />}
            onClick={() => navigate(`/orders/${id}/edit`)}
          >
            ערוך
          </Button>
          <Button
            variant="outlined" size="large"
            startIcon={<GroupAddIcon />}
            onClick={() => setInviteOpen(true)}
          >
            הזמן סניף להצטרף
          </Button>
          <Button
            variant="outlined" color="error" size="large"
            startIcon={<CancelIcon />}
            onClick={() => setConfirm({ open: true, action: 'cancel' })}
          >
            מחק
          </Button>
        </Stack>
      )}
```

Wire the dialog next to `<ReceiveOrderDialog ... />`:
```jsx
      <InviteBranchDialog
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        orderId={id}
        onInvited={() => { setGroupKey(k => k + 1); api.get(`/orders/${id}`).then(r => setOrder(r.data.order)).catch(() => {}); }}
      />
```

Extend the `ConfirmDialog` props:
```jsx
        onConfirm={
          confirm.action === 'approve' ? handleApprove
          : confirm.action === 'arrived' ? handleMarkArrived
          : confirm.action === 'send' ? handleSend
          : handleCancel
        }
        title={
          confirm.action === 'approve' ? 'אישור הזמנה'
          : confirm.action === 'arrived' ? 'סימון כהגיע'
          : confirm.action === 'send' ? 'שליחה לספק'
          : 'ביטול הזמנה'
        }
        message={
          confirm.action === 'approve' ? 'לאשר את ההזמנה?'
          : confirm.action === 'arrived' ? 'לסמן את ההזמנה כהגיעה? תוכל לאשר קבלה ולעדכן מלאי בשלב הבא.'
          : confirm.action === 'send' ? (order.group_id ? 'לשלוח לספק את ההזמנות של כל הסניפים בקבוצה? סניף שלא הוסיף פריטים לא יישלח.' : 'לשלוח את ההזמנה לספק במייל?')
          : 'לבטל את ההזמנה?'
        }
```

Also: the "שלח מייל" header button (`handleResendEmail`) must be hidden for a draft — wrap it: `{order.status !== 'draft' && (<Button ...>שלח מייל</Button>)}`. A draft has never been sent; resending it would email the supplier without the claim.

- [ ] **Step 3: OrderList**

Change `draft: { label: 'טיוטה', color: 'default' },` to `draft: { label: 'בהמתנה', color: 'default' },`.

Add import `import GroupsIcon from '@mui/icons-material/Groups';`.

In the status cell, replace
```jsx
                      <Chip label={status.label} color={status.color} size="small" variant="outlined" />
```
with
```jsx
                      <Stack direction="row" spacing={0.5} alignItems="center">
                        <Chip label={status.label} color={status.color} size="small" variant="outlined" />
                        {order.group_id && <Chip icon={<GroupsIcon />} label="משותפת" size="small" color="primary" variant="outlined" />}
                      </Stack>
```

- [ ] **Step 4: Build, ratchet, run all touched server tests**

Run:
```bash
cd ~/dev/gan-halomot/client && npm run build && cd ../server && node scripts/design-hex-budget.test.js | tail -1 && node scripts/order-group.test.js | tail -1 && node scripts/supplier-catalogue.test.js | tail -1 && node scripts/order-delivery.test.js | tail -1
```
Expected: build ok, ratchet unchanged, three test files green.

- [ ] **Step 5: Manual smoke in the browser (preview)**

Start `gan-server` and `gan-client` from `.claude/launch.json`, log in as an admin, and walk: new order → "שמור בהמתנה" → order page shows בהמתנה + four buttons → "הזמן סניף להצטרף" → pick a branch → group panel shows two rows → "ערוך" on the invited draft (switch branch selector) → add an item → "שלח לספק — כל הסניפים" → both orders `pending`, one email attempt recorded. Screenshot the group panel for the user.

- [ ] **Step 6: Commit**

```bash
cd ~/dev/gan-halomot
git add client/src/components/orders/OrderView.jsx client/src/components/orders/OrderList.jsx
git commit -m "feat(orders): a waiting order can be sent, edited, shared with a branch or deleted from its page

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review

- **Spec coverage:** hold on create (T2), send later (T2), anyone at the branch (existing scope + T7 buttons), invite + linked draft + notification (T3), group summary without items (T3), joint email with one document per branch (T4), minimum on joint total server+client (T4, T6), empty member cancelled (T2 `send`), duplicate branch refused (T3), concurrent send (T2 claim), notification resolved on items/send/delete (T3), button rename (T6), label בהמתנה (T7), list filter (existing select iterates `STATUS_MAP`, so בהמתנה appears automatically) + group chip (T7), invited banner (T6, T7).
- **Types:** `dispatchOrders(orderIds, { supplier, user })` returns plain objects with `id`; `send` returns `{ order, sent_count }`; `group` returns `members[].is_mine`; the client reads exactly those names.
- **Placeholders:** none — every step carries its code.
