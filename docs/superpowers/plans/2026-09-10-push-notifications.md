# Push Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Managers get a push notification (browser Web Push now, native FCM once the app is installed) the moment a new lead, punch-approval request, or cross-branch punch correction needs them — repeating hourly until someone resolves it, and disappearing everywhere the instant it's resolved.

**Architecture:** A generic `NotificationEvent` (one row per recipient, `pending`/`resolved`) is the single source of truth for "who still needs to be told about what." `notification.service.js` exposes `createEvent`/`resolveEvents` for any controller to call, and internally fans a send out to every channel a recipient has registered — the already-existing (but never-called) native FCM pipeline, and a new browser Web Push pipeline (VAPID + `web-push` npm package + a minimal, cache-free service worker). A 5-minute job resends anything still `pending` whose `next_send_at` has passed; `createEvent` also sends immediately so the first push isn't delayed up to 5 minutes.

**Tech Stack:** Node/Express/Mongoose (existing), `web-push` npm package (new), native browser Push API + Service Worker (new, web client only — the Capacitor native app already has its own working FCM registration and needs no changes).

**Spec:** `docs/superpowers/specs/2026-09-10-push-notifications-design.md`

## Global Constraints

- Never touch `approval_status` payroll semantics — this feature only *observes* existing state transitions and creates/resolves notification rows; it must never change what counts toward salary. (Spec §7, and the standing invariant this whole app enforces around `Punch.pending_edit`.)
- A missing/misconfigured channel (no `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`, no `FCM_SERVICE_ACCOUNT`, a dead subscription) is always a **silent no-op**, never a thrown error that blocks the request that triggered it — matches the SMS/email/FCM philosophy already established everywhere in this codebase.
- The web client's `index.html` carries a deliberate, explicit decision to ship **no service worker at all**, because a worker that caches anything traps non-technical staff on a stale build after every deploy (see the comment at the top of `client/index.html`). The new service worker this plan adds (`client/public/sw.js`) must have **no `fetch` event listener and cache nothing whatsoever** — only `push` and `notificationclick`. This is not optional; it is the one thing that would silently reintroduce the exact bug that comment was written to prevent.
- When a manager (or accountant/admin) resolves an item — approves/rejects a punch, changes a lead's status away from `'new'` — every recipient's pending row for that item is resolved at once, including managers who never opened the push. Matches the existing "first to decide, closes it" rule already built for cross-branch punch approval this session.
- Fallback recipients: whenever a branch-scoped lookup finds zero active branch managers, recipients fall back to every `system_admin` user — matching the identical fallback `leads.controller.js#notifyNewLead` and `crossBranchEditGate` already use.
- All UI copy is Hebrew, matching the rest of this app.

---

### Task 1: `web-push` dependency + VAPID configuration

**Files:**
- Modify: `server/package.json` (already has `web-push` installed in this worktree — this task just confirms/commits it)
- Modify: `server/src/config/env.js`
- Modify: `server/.env.example`

**Interfaces:**
- Produces: `env.VAPID_PUBLIC_KEY`, `env.VAPID_PRIVATE_KEY`, `env.VAPID_SUBJECT` — consumed by Task 4 (`notification.service.js`) and Task 6 (the vapid-public-key endpoint).

- [ ] **Step 1: Confirm `web-push` is a declared dependency**

```bash
cd server && grep -n '"web-push"' package.json
```
Expected: a line like `"web-push": "^3.6.7"` under `dependencies`. If missing, run:
```bash
cd server && npm install web-push --save
```

- [ ] **Step 2: Add VAPID env vars to `server/src/config/env.js`**

Add these lines right after the existing `FCM_SERVICE_ACCOUNT` line (end of the file, before the closing `};`):

```js
  // Web Push (browser) — VAPID keypair identifies this server to the push
  // services (Chrome/Firefox/etc.) without a third-party account. Generate
  // once with `node -e "console.log(require('web-push').generateVAPIDKeys())"`
  // and set both halves on Render; a missing pair means web push is a silent
  // no-op, the same as a missing FCM_SERVICE_ACCOUNT.
  VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY,
  VAPID_SUBJECT: process.env.VAPID_SUBJECT || 'mailto:support@ganhahalomot.co.il',
```

- [ ] **Step 3: Document the new env vars in `server/.env.example`**

Add, near wherever `FCM_SERVICE_ACCOUNT` (or the nearest push-related block) is documented:

```
# Web Push (browser) — generate with:
#   node -e "console.log(require('web-push').generateVAPIDKeys())"
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:support@ganhahalomot.co.il
```

- [ ] **Step 4: Verify the server still boots**

```bash
cd server && node --check src/config/env.js && DISABLE_JOBS=1 node -e "require('./src/config/env')" && echo OK
```
Expected: `OK`, no throw.

- [ ] **Step 5: Commit**

```bash
git add server/package.json server/package-lock.json server/src/config/env.js server/.env.example
git commit -m "feat(push): add web-push dependency and VAPID env config"
```

---

### Task 2: `NotificationEvent` model

**Files:**
- Create: `server/src/models/NotificationEvent.js`
- Modify: `server/src/models/index.js`
- Test: `server/scripts/notification-event-model.test.js`

**Interfaces:**
- Produces: `NotificationEvent` mongoose model, exported from `../models`, with schema fields `type` (`'new_lead'|'punch_pending_manager'|'punch_pending_accountant'`), `ref_collection` (String), `ref_id` (ObjectId), `recipient_id` (ObjectId, ref `User`), `title` (String), `body` (String), `url` (String), `status` (`'pending'|'resolved'`), `last_sent_at` (Date|null), `next_send_at` (Date), `resolved_at` (Date|null), timestamps `created_at`/`updated_at`.

- [ ] **Step 1: Write the model**

```js
// server/src/models/NotificationEvent.js
const mongoose = require('mongoose');

/**
 * One notification, for one recipient, about one underlying record.
 *
 * Delivery and resolution are deliberately decoupled: this row says WHO
 * still needs telling about WHAT, and stays 'pending' until something that
 * already changes the underlying record (an approval, a status change)
 * explicitly resolves it — never because a push was sent. A row is sent
 * again every hour (see notification.service.js#deliver / the resend job in
 * index.js) for as long as it stays pending, whether or not the recipient
 * ever acted on the last one.
 *
 * Two documents can point at the same (ref_collection, ref_id) — one row per
 * recipient — so that resolving the underlying record can close every
 * recipient's row in one update (see resolveEvents), including a manager who
 * never opened her push at all.
 */
const notificationEventSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['new_lead', 'punch_pending_manager', 'punch_pending_accountant'],
    required: true,
  },
  ref_collection: { type: String, required: true }, // 'Lead' | 'Punch'
  ref_id: { type: mongoose.Schema.Types.ObjectId, required: true },
  recipient_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  title: { type: String, required: true },
  body: { type: String, required: true },
  url: { type: String, default: '' }, // deep link the client opens on tap

  status: { type: String, enum: ['pending', 'resolved'], default: 'pending' },
  last_sent_at: { type: Date, default: null },
  next_send_at: { type: Date, required: true },
  resolved_at: { type: Date, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

// The resend job's query.
notificationEventSchema.index({ status: 1, next_send_at: 1 });
// resolveEvents' query.
notificationEventSchema.index({ ref_collection: 1, ref_id: 1 });
// createEvent's dedup check (one pending row per type+ref+recipient).
notificationEventSchema.index({ type: 1, ref_id: 1, recipient_id: 1, status: 1 });

module.exports = mongoose.model('NotificationEvent', notificationEventSchema);
```

- [ ] **Step 2: Register it in `server/src/models/index.js`**

Add the require, alphabetically-ish near the other recently-added models (right after `const DataDeletionRequest = require('./DataDeletionRequest');`):

```js
const NotificationEvent = require('./NotificationEvent');
```

Add to the exported `real` object (right after `DataDeletionRequest,`):

```js
  NotificationEvent,
```

- [ ] **Step 3: Write a model-level test**

```js
// server/scripts/notification-event-model.test.js
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
```

- [ ] **Step 4: Run it**

```bash
cd server && node --check src/models/NotificationEvent.js && node --check src/models/index.js && node scripts/notification-event-model.test.js
```
Expected: all checks pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/models/NotificationEvent.js server/src/models/index.js server/scripts/notification-event-model.test.js
git commit -m "feat(push): add NotificationEvent model"
```

---

### Task 3: `WebPushSubscription` model

**Files:**
- Create: `server/src/models/WebPushSubscription.js`
- Modify: `server/src/models/index.js`

**Interfaces:**
- Produces: `WebPushSubscription` model — `user_id` (ObjectId ref User), `endpoint` (String, unique), `keys.p256dh`/`keys.auth` (String), timestamps.

- [ ] **Step 1: Write the model**

```js
// server/src/models/WebPushSubscription.js
const mongoose = require('mongoose');

/**
 * One browser's Web Push subscription — the counterpart to the existing
 * `PushSubscription` (native FCM), kept as a separate model rather than
 * merged in: different shape (`endpoint`+`keys` vs. `fcm_token`+`platform`),
 * different send call (`web-push` npm vs. fcm.service.js), and merging them
 * would mean touching the already-shipped native push model for a browser
 * feature it has nothing to do with.
 *
 * Always staff (`user_id`) — no parent-portal web push in v1.
 */
const webPushSubscriptionSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  endpoint: { type: String, required: true, unique: true },
  keys: {
    p256dh: { type: String, required: true },
    auth: { type: String, required: true },
  },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

module.exports = mongoose.model('WebPushSubscription', webPushSubscriptionSchema);
```

- [ ] **Step 2: Register it in `server/src/models/index.js`**

Add the require right after `const NotificationEvent = require('./NotificationEvent');`:

```js
const WebPushSubscription = require('./WebPushSubscription');
```

Add to the `real` object right after `NotificationEvent,`:

```js
  WebPushSubscription,
```

- [ ] **Step 3: Verify**

```bash
cd server && node --check src/models/WebPushSubscription.js && node --check src/models/index.js
```

- [ ] **Step 4: Commit**

```bash
git add server/src/models/WebPushSubscription.js server/src/models/index.js
git commit -m "feat(push): add WebPushSubscription model"
```

---

### Task 4: `notification.service.js`

**Files:**
- Create: `server/src/services/notification.service.js`
- Test: `server/scripts/notification-service.test.js`

**Interfaces:**
- Consumes: `NotificationEvent`, `WebPushSubscription`, `PushSubscription`, `User` (from `../models`); `sendPush` from `../services/fcm.service` (existing, `{ok, unregistered}`); `web-push` npm package.
- Produces:
  - `async function createEvent({ type, ref_collection, ref_id, recipient_id, title, body, url })` → returns the `NotificationEvent` doc (existing pending one if a dedup match is found, otherwise a freshly created one — the immediate send is fired off in the background, never awaited by the caller).
  - `async function resolveEvents({ ref_collection, ref_id })` → resolves every pending row for that ref, returns nothing.
  - `async function resendDue()` → finds and (re)delivers every row due for a resend; called by the Task 5 job.
  - `async function branchManagerIds(branchId)` → `string[]` of recipient user ids: that branch's active `branch_manager`s (matched on `managed_branch_ids` or `branch_id`), falling back to every `system_admin` if none. `branchId` may be `null`/falsy, in which case it goes straight to the `system_admin` fallback.
  - `async function accountantIds()` → `string[]` of every active `accountant` user id.

- [ ] **Step 1: Write the failing test first**

```js
// server/scripts/notification-service.test.js
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
  for (let i = 0; i < tries; i++) { if (pred()) return true; await sleep(50); }
  return pred();
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
```

- [ ] **Step 2: Run it and confirm it fails** (the service module doesn't exist yet)

```bash
cd server && node scripts/notification-service.test.js
```
Expected: `Error: Cannot find module '../src/services/notification.service'`.

- [ ] **Step 3: Write the service**

```js
// server/src/services/notification.service.js
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
```

- [ ] **Step 4: Run the test again**

```bash
cd server && node --check src/services/notification.service.js && node scripts/notification-service.test.js
```
Expected: all checks pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/notification.service.js server/scripts/notification-service.test.js
git commit -m "feat(push): add notification.service.js (createEvent/resolveEvents/resendDue)"
```

---

### Task 5: Resend job

**Files:**
- Modify: `server/src/index.js`

**Interfaces:**
- Consumes: `notification.service.js#resendDue` (Task 4).

- [ ] **Step 1: Add the job**, in the same block as the other `setInterval`-based jobs (right after the `reconcileReminder` job block, before the closing `});\n\n  module.exports = app;`):

```js
    // התראות פוש: כל 5 דקות, כל מה שממתין ועבר עליו שעה מהשליחה הקודמת
    // נשלח שוב. יצירת אירוע חדש שולחת מיד בעצמה (notification.service.js);
    // ה-job הזה הוא רק החזרה החוזרת עד שמישהו מטפל.
    const notificationService = require('./services/notification.service');
    const runNotificationResend = () => notificationService.resendDue()
      .then(n => { if (n) console.log(`[notifications] resent ${n} pending`); })
      .catch(e => console.error('[notifications] resend failed:', e.message));
    if (!platformMode) {
      setInterval(runNotificationResend, 5 * 60 * 1000);
    }
```

- [ ] **Step 2: Verify the server still boots with `DISABLE_JOBS=1` (jobs skipped) and without it (jobs registered, nothing throws in the first 3 seconds)**

```bash
cd server && node --check src/index.js
DISABLE_JOBS=1 MONGODB_URI="mongodb://127.0.0.1:1/x" PORT=0 timeout 3 node -e "
process.env.JWT_SECRET='t'; process.env.PARENT_SECRET='t';
try { require('./src/index.js'); } catch(e) { console.error(e.message); }
" 2>&1 | tail -5
```
Expected: no syntax errors; a Mongo connection error is fine here (no real DB), the point is the file parses and the job block doesn't throw before that.

- [ ] **Step 3: Commit**

```bash
git add server/src/index.js
git commit -m "feat(push): wire the 5-minute notification resend job"
```

---

### Task 6: Web push routes — subscribe/unsubscribe/public-key

**Files:**
- Modify: `server/src/controllers/push.controller.js`
- Modify: `server/src/routes/push.routes.js`
- Test: `server/scripts/push-web-routes.test.js`

**Interfaces:**
- Produces: `POST /api/push/register-web` (body `{ endpoint, keys: { p256dh, auth } }`, upserts a `WebPushSubscription` for `req.user.id`), `POST /api/push/unregister-web` (body `{ endpoint }`, deletes it), `GET /api/push/vapid-public-key` (returns `{ publicKey: env.VAPID_PUBLIC_KEY || null }`) — all under the existing `authMiddleware`-guarded `push.routes.js`, no role restriction (matches `registerStaff`'s existing lack of one).

- [ ] **Step 1: Write the failing test**

```js
// server/scripts/push-web-routes.test.js
#!/usr/bin/env node
/**
 * Web push subscribe/unsubscribe + the public-key endpoint, against a real
 * booted server.
 *
 *   node scripts/push-web-routes.test.js
 */
const net = require('net');
const http = require('http');

const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};

const { MongoMemoryServer } = require('mongodb-memory-server');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

const PASSWORD = 'test1234';
let failures = 0;
let checks = 0;
function ok(cond, label, detail = '') {
  checks++;
  if (cond) console.log(`  ✅ ${label}`);
  else { failures++; console.log(`  ❌ ${label}${detail ? `  (${detail})` : ''}`); }
}
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), label, `קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)}`);

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}
let PORT = 0;
function request({ method = 'GET', path, token, body }) {
  return new Promise((resolve, reject) => {
    const h = {};
    let payload = null;
    if (body !== undefined) {
      payload = Buffer.from(JSON.stringify(body));
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = payload.length;
    }
    if (token) h.Authorization = `Bearer ${token}`;
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: json, text });
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try { const r = await request({ path: '/api/health' }); if (r.status === 200) return true; } catch { /* not up */ }
    await sleep(200);
  }
  throw new Error('השרת לא ענה על /api/health');
}
async function login(full_name, id_number) {
  const r = await request({ method: 'POST', path: '/api/auth/login-password', body: { full_name, id_number, password: PASSWORD } });
  if (r.status !== 200 || !r.body?.token) throw new Error(`התחברות נכשלה: ${r.status} ${r.text}`);
  return r.body.token;
}

let mongod = null, server = null;

async function main() {
  console.log('=== מנויי פוש דפדפן — register-web / unregister-web / vapid-public-key ===');
  mongod = await MongoMemoryServer.create({ instance: { dbName: 'gan_push_web_routes' } });
  PORT = await freePort();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_SECRET = 'push-web-secret';
  process.env.PARENT_SECRET = 'push-web-parent-secret';
  process.env.DISABLE_JOBS = '1';
  process.env.PORT = String(PORT);
  process.env.FRONTEND_URL = 'http://localhost:4173';
  process.env.NODE_ENV = 'development';
  process.env.GC_REEXEC = '1';
  process.env.VAPID_PUBLIC_KEY = 'test-public-key';
  delete process.env.PLATFORM_MONGODB_URI;

  const express = require('express');
  const originalListen = express.application.listen;
  express.application.listen = function patched(...args) { server = originalListen.apply(this, args); return server; };
  require('../src/index.js');
  await waitForServer();
  express.application.listen = originalListen;

  const host = String(mongoose.connection.host || '');
  if (!/^(127\.0\.0\.1|localhost|::1)$/.test(host)) throw new Error(`מסד הנתונים אינו מקומי (${host}) — עוצרים`);

  const { User, WebPushSubscription } = require('../src/models');
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  await User.create({
    email: 'm@x.local', full_name: 'מנהלת', id_number: '444444444', role: 'branch_manager',
    position: 'x', password_hash: passwordHash, password_set: true, is_active: true,
  });
  const token = await login('מנהלת', '444444444');

  console.log('\nבדיקה 1 — מפתח ה-VAPID הציבורי');
  const key = await request({ token, path: '/api/push/vapid-public-key' });
  eq(key.status, 200, '1a מוחזר בהצלחה');
  eq(key.body.publicKey, 'test-public-key', '1b המפתח הנכון');

  console.log('\nבדיקה 2 — הרשמה');
  const sub = await request({
    method: 'POST', token, path: '/api/push/register-web',
    body: { endpoint: 'https://push.example/ep-1', keys: { p256dh: 'p', auth: 'a' } },
  });
  eq(sub.status, 200, '2a נרשם בהצלחה');
  eq(await WebPushSubscription.countDocuments({}), 1, '2b נשמר מנוי אחד');

  console.log('\nבדיקה 3 — הרשמה חוזרת על אותו endpoint לא כופלת');
  await request({
    method: 'POST', token, path: '/api/push/register-web',
    body: { endpoint: 'https://push.example/ep-1', keys: { p256dh: 'p2', auth: 'a2' } },
  });
  eq(await WebPushSubscription.countDocuments({}), 1, '3a עדיין מנוי אחד בלבד');
  const row = await WebPushSubscription.findOne({}).lean();
  eq(row.keys.p256dh, 'p2', '3b אבל המפתחות עודכנו');

  console.log('\nבדיקה 4 — ביטול הרשמה');
  const unsub = await request({ method: 'POST', token, path: '/api/push/unregister-web', body: { endpoint: 'https://push.example/ep-1' } });
  eq(unsub.status, 200, '4a בוטל בהצלחה');
  eq(await WebPushSubscription.countDocuments({}), 0, '4b נמחק מהמסד');

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} בדיקות עברו`);
}

main()
  .catch(err => { console.error('\n💥', err); failures++; })
  .finally(async () => {
    try { if (server) await new Promise(r => server.close(r)); } catch { /* closing */ }
    try { await mongoose.disconnect(); } catch { /* disconnecting */ }
    try { if (mongod) await mongod.stop(); } catch { /* stopping */ }
    process.exit(failures === 0 ? 0 : 1);
  });
```

- [ ] **Step 2: Run it, confirm it fails** (routes don't exist yet — expect 404s, so `eq` assertions on status 200 fail)

```bash
cd server && node scripts/push-web-routes.test.js
```

- [ ] **Step 3: Add the controller functions** — append to `server/src/controllers/push.controller.js`, after the existing `exports.unregister = unregister;` line:

```js
const { WebPushSubscription } = require('../models');
const env = require('../config/env');

/** POST /api/push/register-web — upsert this browser's Web Push subscription. */
async function registerWeb(req, res) {
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'endpoint ו-keys נדרשים' });
  }
  await WebPushSubscription.findOneAndUpdate(
    { endpoint },
    { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, user_id: req.user.id },
    { upsert: true }
  );
  res.json({ ok: true });
}

/** POST /api/push/unregister-web */
async function unregisterWeb(req, res) {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'endpoint נדרש' });
  await WebPushSubscription.deleteOne({ endpoint });
  res.json({ ok: true });
}

/** GET /api/push/vapid-public-key */
function vapidPublicKey(req, res) {
  res.json({ publicKey: env.VAPID_PUBLIC_KEY || null });
}

exports.registerWeb = registerWeb;
exports.unregisterWeb = unregisterWeb;
exports.vapidPublicKey = vapidPublicKey;
```

- [ ] **Step 4: Move the `const { WebPushSubscription } = require('../models');` and `const env = require('../config/env');` lines to the top of the file** (alongside the existing `const { PushSubscription } = require('../models');`), so there's one set of requires at the top rather than mid-file:

```js
// server/src/controllers/push.controller.js — top of file becomes:
const { PushSubscription, WebPushSubscription } = require('../models');
const env = require('../config/env');
```
(Delete the duplicate `const { WebPushSubscription } = require('../models'); const env = require('../config/env');` lines added in Step 3.)

- [ ] **Step 5: Add the routes** — `server/src/routes/push.routes.js`, after the existing two routes:

```js
router.post('/register-web', c.registerWeb);
router.post('/unregister-web', c.unregisterWeb);
router.get('/vapid-public-key', c.vapidPublicKey);
```

- [ ] **Step 6: Run the test again**

```bash
cd server && node --check src/controllers/push.controller.js && node --check src/routes/push.routes.js && node scripts/push-web-routes.test.js
```
Expected: all checks pass.

- [ ] **Step 7: Commit**

```bash
git add server/src/controllers/push.controller.js server/src/routes/push.routes.js server/scripts/push-web-routes.test.js
git commit -m "feat(push): register-web/unregister-web/vapid-public-key endpoints"
```

---

### Task 7: Client — minimal, cache-free service worker

**Files:**
- Create: `client/public/sw.js`

**Interfaces:**
- Produces: a static file served at `/sw.js` by Vite's `public/` passthrough. No JS interface — consumed by the browser's Push API once registered (Task 8).

- [ ] **Step 1: Write the file**

```js
// client/public/sw.js
//
// Push-only. NO fetch handler, NO caching — see the comment at the top of
// client/index.html for why a caching service worker is explicitly banned in
// this app (it traps non-technical staff on a stale build after a deploy).
// This worker exists for exactly two events and nothing else.

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* not JSON */ }
  const title = data.title || 'גן החלומות';
  const body = data.body || '';
  const url = data.url || '/';
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icon-192.png',
      data: { url },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) { client.focus(); if ('navigate' in client) client.navigate(url); return; }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
```

- [ ] **Step 2: Verify it's plain, valid JS and has no fetch handler**

```bash
cd client && node --check public/sw.js && grep -c "addEventListener('fetch'" public/sw.js
```
Expected: `node --check` passes silently; the `grep -c` prints `0`.

- [ ] **Step 3: Commit**

```bash
git add client/public/sw.js
git commit -m "feat(push): add a minimal, cache-free service worker for browser push"
```

---

### Task 8: Client — `webPush.js` util (register/unregister)

**Files:**
- Create: `client/src/utils/webPush.js`

**Interfaces:**
- Consumes: `GET /push/vapid-public-key`, `POST /push/register-web`, `POST /push/unregister-web` (via whichever axios instance is passed in, matching `nativePush.js`'s pattern).
- Produces: `async function isWebPushSupported()` → `boolean`; `async function getWebPushSubscriptionState(registerEndpoint)` → `'unsupported'|'default'|'denied'|'subscribed'|'not-subscribed'`; `async function subscribeWebPush(registerEndpoint)` → `Promise<void>`, throws on failure (the caller shows the error); `async function unsubscribeWebPush(registerEndpoint)` → `Promise<void>`.

- [ ] **Step 1: Write the util**

```js
// client/src/utils/webPush.js
import { Capacitor } from '@capacitor/core';

/**
 * Browser Web Push — the counterpart to utils/nativePush.js, for the site
 * itself rather than the installed app. Inert (and never even imported by
 * anything that matters) on a native build: Capacitor.isNativePlatform()
 * true means nativePush.js is already handling it through FCM directly.
 */

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export async function isWebPushSupported() {
  return (
    !Capacitor.isNativePlatform()
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window
  );
}

export async function getWebPushSubscriptionState() {
  if (!(await isWebPushSupported())) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration('/sw.js');
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  return sub ? 'subscribed' : 'not-subscribed';
}

export async function subscribeWebPush(registerEndpoint) {
  if (!(await isWebPushSupported())) throw new Error('הדפדפן הזה לא תומך בהתראות');

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('לא ניתנה הרשאה להתראות');

  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;

  const { data } = await registerEndpoint.get('/push/vapid-public-key');
  if (!data?.publicKey) throw new Error('התראות דפדפן לא מוגדרות בשרת');

  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(data.publicKey),
  });
  const json = subscription.toJSON();
  await registerEndpoint.post('/push/register-web', { endpoint: json.endpoint, keys: json.keys });
}

export async function unsubscribeWebPush(registerEndpoint) {
  const reg = await navigator.serviceWorker.getRegistration('/sw.js');
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  await registerEndpoint.post('/push/unregister-web', { endpoint }).catch(() => {});
}
```

- [ ] **Step 2: Verify it parses**

```bash
cd client && npx vite build 2>&1 | tail -20
```
Expected: builds clean (this file isn't imported yet, so this just confirms no syntax error via the bundler picking it up if referenced later — safe to defer full confirmation to Task 9's build).

- [ ] **Step 3: Commit**

```bash
git add client/src/utils/webPush.js
git commit -m "feat(push): add client webPush util (subscribe/unsubscribe)"
```

---

### Task 9: Client — "הפעילי התראות בדפדפן" button in `Header.jsx`

**Files:**
- Modify: `client/src/components/layout/Header.jsx`

**Interfaces:**
- Consumes: `isWebPushSupported`, `getWebPushSubscriptionState`, `subscribeWebPush`, `unsubscribeWebPush` from `../../utils/webPush` (Task 8); the existing `api` instance already imported in this file.

- [ ] **Step 1: Add the import**, alongside the existing `import DeleteAccountRequest from '../shared/DeleteAccountRequest';` line:

```js
import { isWebPushSupported, getWebPushSubscriptionState, subscribeWebPush, unsubscribeWebPush } from '../../utils/webPush';
import NotificationsActiveIcon from '@mui/icons-material/NotificationsActive';
import NotificationsOffIcon from '@mui/icons-material/NotificationsOff';
```

- [ ] **Step 2: Add state and a load-on-mount effect**, right after the existing `const [navMenu, setNavMenu] = useState(null);` line:

```js
  const [pushSupported, setPushSupported] = useState(false);
  const [pushSubscribed, setPushSubscribed] = useState(false);
  useEffect(() => {
    isWebPushSupported().then(async (supported) => {
      setPushSupported(supported);
      if (supported) setPushSubscribed((await getWebPushSubscriptionState()) === 'subscribed');
    });
  }, []);
```

This needs `useEffect` imported — change the existing `import { useCallback, useState } from 'react';` at the top of the file to:

```js
import { useCallback, useState, useEffect } from 'react';
```

- [ ] **Step 3: Add the toggle handler**, right after the existing `handleSetupBiometric` function:

```js
  const handleTogglePush = useCallback(async () => {
    try {
      if (pushSubscribed) {
        await unsubscribeWebPush(api);
        setPushSubscribed(false);
        toast.success('התראות דפדפן כובו');
      } else {
        await subscribeWebPush(api);
        setPushSubscribed(true);
        toast.success('התראות דפדפן הופעלו!');
      }
    } catch (err) {
      toast.error(err.message || 'שגיאה בהגדרת התראות');
    }
  }, [pushSubscribed]);
```

- [ ] **Step 4: Add the button**, right after the existing biometric `<Tooltip title="הגדר כניסה ביומטרית">...</Tooltip>` block (desktop toolbar area, ~line 297):

```jsx
              {pushSupported && (
                <Tooltip title={pushSubscribed ? 'כבה התראות דפדפן' : 'הפעילי התראות בדפדפן'}>
                  <IconButton size="small" onClick={handleTogglePush} sx={{ color: pushSubscribed ? '#16a34a' : '#94a3b8' }}>
                    {pushSubscribed ? <NotificationsActiveIcon sx={{ fontSize: '1rem' }} /> : <NotificationsOffIcon sx={{ fontSize: '1rem' }} />}
                  </IconButton>
                </Tooltip>
              )}
```

- [ ] **Step 5: Build and manually verify in the browser**

```bash
cd client && npx vite build 2>&1 | tail -20
```
Expected: builds clean. Then, per this session's UI-verification pattern: `preview_start` the dev server, log in as a `branch_manager`/`system_admin` test user, confirm the new bell icon appears in the header toolbar, click it, confirm the browser's permission prompt appears (accept it in the test environment if possible, or at minimum confirm no console error before the prompt), and confirm the icon's color/tooltip flips.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/layout/Header.jsx
git commit -m "feat(push): add browser-notifications toggle to the header"
```

---

### Task 10: Wire `leads.controller.js`

**Files:**
- Modify: `server/src/controllers/leads.controller.js`

**Interfaces:**
- Consumes: `notification.service.js#createEvent`, `#branchManagerIds` (Task 4).

- [ ] **Step 1: Add the import**, at the top of the file, after `const { sendSms } = require('../services/sms.service');`:

```js
const notificationService = require('../services/notification.service');
```

- [ ] **Step 2: Create the push event in `publicSubmit`**, right after the existing `notifyNewLead(lead, branch).catch(err => console.error('lead notify failed:', err.message));` line:

```js
    notificationService.branchManagerIds(lead.branch_id).then((ids) => {
      const branchName = branch?.name || 'לא נבחר סניף';
      ids.forEach((recipient_id) => notificationService.createEvent({
        type: 'new_lead', ref_collection: 'Lead', ref_id: lead._id, recipient_id,
        title: 'ליד חדש בגן החלומות',
        body: `${lead.parent_name} — ${branchName}`,
        url: '/leads',
      }));
    }).catch(err => console.error('lead push notify failed:', err.message));
```

- [ ] **Step 3: Resolve the event in `update`**, right after the existing `if (req.body.status !== undefined) { ... setObj.status = req.body.status; setObj.handled_by = req.user?.id || null; }` block, still inside `update`, before the `Lead.findByIdAndUpdate` call:

```js
    if (req.body.status !== undefined && req.body.status !== 'new') {
      notificationService.resolveEvents({ ref_collection: 'Lead', ref_id: req.params.id })
        .catch(err => console.error('lead push resolve failed:', err.message));
    }
```

- [ ] **Step 4: Verify**

```bash
cd server && node --check src/controllers/leads.controller.js
```

- [ ] **Step 5: Extend `server/scripts/leads-notifications.test.js` with push assertions** — add `NotificationEvent`, `PushSubscription`/`WebPushSubscription` stubs (same `require.cache` trick already used for `fcm.service`/`web-push` in Task 4's test) and two new checks: (a) after test 1's lead submit, a `pending` `NotificationEvent` of type `'new_lead'` exists for `tania` (the branch manager); (b) after the manager changes the lead's status away from `'new'` (a `PUT /api/leads/:id`), that event is `resolved`. Write these as a 6th `head()` block appended to the existing file, following the same `ok`/`eq` helpers already in that file.

- [ ] **Step 6: Run the full test file**

```bash
cd server && node scripts/leads-notifications.test.js
```
Expected: all checks (old and new) pass.

- [ ] **Step 7: Commit**

```bash
git add server/src/controllers/leads.controller.js server/scripts/leads-notifications.test.js
git commit -m "feat(push): wire new_lead notification events into leads.controller.js"
```

---

### Task 11: Wire `payroll.controller.js` — `createManualPunches`

**Files:**
- Modify: `server/src/controllers/payroll.controller.js`

**Interfaces:**
- Consumes: `notification.service.js#createEvent`, `#branchManagerIds`, `#accountantIds` (Task 4).

- [ ] **Step 1: Add the import**, at the top of the file, after `const { dispatchEmail } = require('../services/email.service');`:

```js
const notificationService = require('../services/notification.service');
```

- [ ] **Step 2: Create events for each pending punch**, in `createManualPunches`, right after the `for (let i = 0; i < pairs.length; i++) { ... created.push(punch); }` loop, before `res.json({ ok: true, created: created.length, punches: created });`:

```js
    for (const punch of created) {
      if (punch.approval_status === 'pending_manager') {
        const ids = await notificationService.branchManagerIds(punchBranchId);
        for (const recipient_id of ids) {
          await notificationService.createEvent({
            type: 'punch_pending_manager', ref_collection: 'Punch', ref_id: punch._id, recipient_id,
            title: 'ממתין לאישורך', body: `${emp.full_name} — דיווח החתמה`, url: '/attendance',
          });
        }
      } else if (punch.approval_status === 'pending_accountant') {
        const ids = await notificationService.accountantIds();
        for (const recipient_id of ids) {
          await notificationService.createEvent({
            type: 'punch_pending_accountant', ref_collection: 'Punch', ref_id: punch._id, recipient_id,
            title: 'ממתין לאישור הנהלת חשבונות', body: `${emp.full_name} — דיווח החתמה`, url: '/attendance',
          });
        }
      }
    }
```

- [ ] **Step 3: Verify**

```bash
cd server && node --check src/controllers/payroll.controller.js
```

- [ ] **Step 4: Commit**

```bash
git add server/src/controllers/payroll.controller.js
git commit -m "feat(push): notify on createManualPunches' pending_manager/pending_accountant"
```

---

### Task 12: Wire `payroll.controller.js` — `editPunch`'s cross-branch staging

**Files:**
- Modify: `server/src/controllers/payroll.controller.js`

**Interfaces:**
- Consumes: `notification.service.js#createEvent`, `#branchManagerIds`, `#accountantIds` (Task 4).

- [ ] **Step 1: Add the accountant-side event to the `isHomeManager` branch** — in `editPunch`, this block:

```js
      if (isHomeManager) {
        p.manager_approved_by = req.user?.id || null;
        p.manager_approved_at = new Date();
      } else {
```

becomes:

```js
      if (isHomeManager) {
        p.manager_approved_by = req.user?.id || null;
        p.manager_approved_at = new Date();
        const accIds = await notificationService.accountantIds();
        for (const recipient_id of accIds) {
          await notificationService.createEvent({
            type: 'punch_pending_accountant', ref_collection: 'Punch', ref_id: p._id, recipient_id,
            title: 'ממתין לאישור הנהלת חשבונות', body: `תיקון החתמה — ${emp?.full_name || ''}`, url: '/attendance',
          });
        }
      } else {
```

(This is the immediate-approval case — a manager correcting her own employee's punch. It goes straight to "waiting on the accountant," so that's the event it needs; there is no manager-stage event for this branch, matching the existing behavior where `manager_approved_by` is filled in immediately.)

- [ ] **Step 2: Add the manager-side event to the cross-branch (`else`) branch** — right after `p.pending_edit.log_id = log._id;`, still inside the `else` block, before the shared code that follows it:

```js
        p.pending_edit.log_id = log._id;
        const homeManagerIds = await notificationService.branchManagerIds(emp.branch_id);
        for (const recipient_id of homeManagerIds) {
          await notificationService.createEvent({
            type: 'punch_pending_manager', ref_collection: 'Punch', ref_id: p._id, recipient_id,
            title: 'תיקון החתמה ממתין לאישורך', body: `${emp.full_name} — סניף ${hostBranch?.name || ''}`, url: '/attendance',
          });
        }
```

- [ ] **Step 3: Verify**

```bash
cd server && node --check src/controllers/payroll.controller.js
```

- [ ] **Step 4: Commit**

```bash
git add server/src/controllers/payroll.controller.js
git commit -m "feat(push): notify on editPunch's cross-branch and same-branch correction staging"
```

---

### Task 13: Wire `payroll.controller.js` — `approvePunch` and `rejectPunch`

**Files:**
- Modify: `server/src/controllers/payroll.controller.js`

**Interfaces:**
- Consumes: `notification.service.js#resolveEvents`, `#accountantIds` (Task 4).

- [ ] **Step 1: Resolve in the pending_edit-apply branch of `approvePunch`** — right before `return res.json({ ok: true, punch: p, applied_edit: true });`:

```js
      await notificationService.resolveEvents({ ref_collection: 'Punch', ref_id: p._id });
      return res.json({ ok: true, punch: p, applied_edit: true });
```

- [ ] **Step 2: Resolve + forward-to-accountant in the cross-branch manager-stage-approve branch** — right before `return res.json({ ok: true, punch: p, pending: true });` (the block that sets `p.pending_edit.manager_approved = true`):

```js
      await notificationService.resolveEvents({ ref_collection: 'Punch', ref_id: p._id });
      const accIds = await notificationService.accountantIds();
      for (const recipient_id of accIds) {
        await notificationService.createEvent({
          type: 'punch_pending_accountant', ref_collection: 'Punch', ref_id: p._id, recipient_id,
          title: 'ממתין לאישור הנהלת חשבונות', body: 'תיקון החתמה חוצה-סניפים', url: '/attendance',
        });
      }
      return res.json({ ok: true, punch: p, pending: true });
```

- [ ] **Step 3: Resolve (and forward, if it was just a manager→accountant step) after the shared if/else-if/else chain** — the code currently reads:

```js
    await p.save();
    res.json({ ok: true, punch: p });
  } catch (err) { next(err); }
}
```

(the one right after the `else if (st === 'pending_accountant' && isFinal) { ... }` / `else { return res.status(403)... }` chain in `approvePunch`) becomes:

```js
    await p.save();
    await notificationService.resolveEvents({ ref_collection: 'Punch', ref_id: p._id });
    if (p.approval_status === 'pending_accountant' && (st === 'pending_manager' || st === 'pending')) {
      const accIds = await notificationService.accountantIds();
      for (const recipient_id of accIds) {
        await notificationService.createEvent({
          type: 'punch_pending_accountant', ref_collection: 'Punch', ref_id: p._id, recipient_id,
          title: 'ממתין לאישור הנהלת חשבונות', body: 'דיווח החתמה', url: '/attendance',
        });
      }
    }
    res.json({ ok: true, punch: p });
  } catch (err) { next(err); }
}
```

- [ ] **Step 4: Resolve in both branches of `rejectPunch`** — the pending_edit-restore branch, right before `return res.json({ ok: true, punch: p, restored: true });`:

```js
      await notificationService.resolveEvents({ ref_collection: 'Punch', ref_id: p._id });
      return res.json({ ok: true, punch: p, restored: true });
```

and the plain-reject branch at the end of the function, right before `res.json({ ok: true, punch: p });`:

```js
    await notificationService.resolveEvents({ ref_collection: 'Punch', ref_id: p._id });
    res.json({ ok: true, punch: p });
  } catch (err) { next(err); }
}
```

- [ ] **Step 5: Verify**

```bash
cd server && node --check src/controllers/payroll.controller.js
```

- [ ] **Step 6: Run the existing punch test suites — confirm zero regressions**

```bash
cd server && node scripts/punch-approval-stage.test.js && node scripts/punch-out-of-scope.test.js && node scripts/cross-branch-punch-edit.test.js
```
Expected: every one of the three still passes 100%. (These predate this feature; a break here means one of this task's edits landed in the wrong branch of the if/else chain.)

- [ ] **Step 7: Commit**

```bash
git add server/src/controllers/payroll.controller.js
git commit -m "feat(push): resolve notification events on punch approve/reject, forward manager→accountant"
```

---

### Task 14: End-to-end test — the full punch notification lifecycle

**Files:**
- Create: `server/scripts/punch-notifications.test.js`

**Interfaces:**
- Consumes: the real booted server (via the standard boilerplate this session has used repeatedly), with `fcm.service` and `web-push` stubbed via `require.cache` (same pattern as Task 4's test and `leads-notifications.test.js`).

- [ ] **Step 1: Write the test**

```js
#!/usr/bin/env node
/**
 * ההחתמה מגיעה, הפוש יוצא, הכל נסגר כשמטפלים — קצה אל קצה, דרך שלושת
 * המסלולים: דיווח עצמי של עובדת, תיקון של מנהלת לעובדת שלה, ותיקון
 * חוצה-סניפים (מנהלת אורחת → מנהלת הבית → הנה"ח).
 *
 *   node scripts/punch-notifications.test.js
 */
const net = require('net');
const http = require('http');

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
    sendPush: async ({ token, title, body }) => { sent.fcm.push({ token, title, body }); return { ok: true, unregistered: false }; },
    isConfigured: () => true,
  },
};
const webPushPath = require.resolve('web-push');
require.cache[webPushPath] = {
  id: webPushPath, filename: webPushPath, loaded: true, children: [], paths: [],
  exports: {
    setVapidDetails: () => {},
    sendNotification: async (subscription, payload) => { sent.web.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) }); return { statusCode: 201 }; },
  },
};

const { MongoMemoryServer } = require('mongodb-memory-server');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

const PASSWORD = 'test1234';
let failures = 0, checks = 0;
function ok(cond, label, detail = '') {
  checks++;
  if (cond) console.log(`  ✅ ${label}`);
  else { failures++; console.log(`  ❌ ${label}${detail ? `  (${detail})` : ''}`); }
}
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), label, `קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)}`);
const head = (t) => console.log(`\n${t}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(pred, tries = 40) {
  for (let i = 0; i < tries; i++) { if (await pred()) return true; await sleep(50); }
  return pred();
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}
let PORT = 0;
function request({ method = 'GET', path, token, body }) {
  return new Promise((resolve, reject) => {
    const h = {};
    let payload = null;
    if (body !== undefined) { payload = Buffer.from(JSON.stringify(body)); h['Content-Type'] = 'application/json'; h['Content-Length'] = payload.length; }
    if (token) h.Authorization = `Bearer ${token}`;
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch { /* not json */ } resolve({ status: res.statusCode, body: json, text }); });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}
async function waitForServer() {
  for (let i = 0; i < 100; i++) { try { const r = await request({ path: '/api/health' }); if (r.status === 200) return true; } catch { /* not up */ } await sleep(200); }
  throw new Error('השרת לא ענה על /api/health');
}
async function login(full_name, id_number) {
  const r = await request({ method: 'POST', path: '/api/auth/login-password', body: { full_name, id_number, password: PASSWORD } });
  if (r.status !== 200 || !r.body?.token) throw new Error(`התחברות נכשלה עבור ${full_name}: ${r.status} ${r.text}`);
  return r.body.token;
}

let mongod = null, server = null;

async function main() {
  console.log('=== התראות פוש על תור אישורי החתמה — קצה אל קצה ===');
  mongod = await MongoMemoryServer.create({ instance: { dbName: 'gan_punch_notifications' } });
  PORT = await freePort();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_SECRET = 'punch-notif-secret';
  process.env.PARENT_SECRET = 'punch-notif-parent-secret';
  process.env.DISABLE_JOBS = '1';
  process.env.PORT = String(PORT);
  process.env.FRONTEND_URL = 'http://localhost:4173';
  process.env.NODE_ENV = 'development';
  process.env.GC_REEXEC = '1';
  process.env.VAPID_PUBLIC_KEY = 'test-public';
  process.env.VAPID_PRIVATE_KEY = 'test-private';
  delete process.env.PLATFORM_MONGODB_URI;

  const express = require('express');
  const originalListen = express.application.listen;
  express.application.listen = function patched(...args) { server = originalListen.apply(this, args); return server; };
  require('../src/index.js');
  await waitForServer();
  express.application.listen = originalListen;

  const host = String(mongoose.connection.host || '');
  if (!/^(127\.0\.0\.1|localhost|::1)$/.test(host)) throw new Error(`מסד הנתונים אינו מקומי (${host}) — עוצרים`);

  const { User, Branch, Employee, PushSubscription, NotificationEvent } = require('../src/models');
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  const branch = await Branch.create({ name: 'הרצליה' });
  const manager = await User.create({ email: 'm@x.local', full_name: 'מנהלת הרצליה', id_number: '555555001', role: 'branch_manager', branch_id: branch._id, position: 'x', password_hash: passwordHash, password_set: true, is_active: true });
  const accountant = await User.create({ email: 'a@x.local', full_name: 'הנהח', id_number: '555555002', role: 'accountant', branch_id: branch._id, position: 'x', password_hash: passwordHash, password_set: true, is_active: true });
  await PushSubscription.create({ user_id: manager._id, fcm_token: 'MGR_TOKEN', platform: 'android' });
  await PushSubscription.create({ user_id: accountant._id, fcm_token: 'ACC_TOKEN', platform: 'android' });
  const emp = await Employee.create({ full_name: 'עובדת בדיקה', israeli_id: '655555001', phone: '050-0000001', email: 'e@x.local', position: 'סייעת', branch_id: branch._id, salary_type: 'hourly', hourly_rate: 50, is_active: true, start_date: new Date('2024-09-01') });

  const tokenManager = await login('מנהלת הרצליה', '555555001');
  const tokenAccountant = await login('הנהח', '555555002');

  head('בדיקה 1 — מנהלת מדווחת עבור העובדת (branch_manager) → ישר pending_accountant, פוש להנה"ח');
  {
    const res = await request({ method: 'POST', token: tokenManager, path: '/api/payroll/manual-punches', body: { employee_id: String(emp._id), date: '2026-09-10', in_time: '08:00', note: '' } });
    ok(res.status === 200, '1a הדיווח נקלט', `${res.status} ${res.text?.slice(0, 200)}`);
    const punchId = res.body.punches[0]._id;
    await waitFor(async () => (await NotificationEvent.countDocuments({ ref_id: punchId, type: 'punch_pending_accountant', recipient_id: accountant._id })) === 1);
    eq(await NotificationEvent.countDocuments({ ref_id: punchId, type: 'punch_pending_accountant', recipient_id: accountant._id, status: 'pending' }), 1, '1b נוצר אירוע פוש להנה"ח');
    await waitFor(() => sent.fcm.some(s => s.token === 'ACC_TOKEN'));
    ok(sent.fcm.some(s => s.token === 'ACC_TOKEN'), '1c ונשלח פוש בפועל');

    const approve = await request({ method: 'PATCH', token: tokenAccountant, path: `/api/payroll/punches/${punchId}/approve` });
    ok(approve.status === 200, '1d הנה"ח מאשרת');
    eq(await NotificationEvent.countDocuments({ ref_id: punchId, status: 'pending' }), 0, '1e האירוע נסגר');
  }

  head('בדיקה 2 — מנהלת מתקנת שעה שכבר נספרת לעובדת שלה (pending_edit רגיל) → פוש להנה"ח מיד');
  {
    const { Punch } = require('../src/models');
    const p = await Punch.create({ branch_id: branch._id, employee_id: emp._id, israeli_id: emp.israeli_id, device_user_sn: 9001, timestamp: new Date('2026-09-10T08:00:00Z'), approval_status: 'auto' });
    sent.fcm.length = 0;
    const res = await request({ method: 'PATCH', token: tokenManager, path: `/api/payroll/punches/${p._id}`, body: { timestamp: new Date('2026-09-10T08:30:00Z').toISOString() } });
    ok(res.status === 200, '2a התיקון נקלט');
    await waitFor(async () => (await NotificationEvent.countDocuments({ ref_id: p._id, type: 'punch_pending_accountant', recipient_id: accountant._id })) === 1);
    eq(await NotificationEvent.countDocuments({ ref_id: p._id, status: 'pending' }), 1, '2b אירוע אחד בלבד, להנה"ח');

    const approve = await request({ method: 'PATCH', token: tokenAccountant, path: `/api/payroll/punches/${p._id}/approve` });
    ok(approve.status === 200, '2c הנה"ח מאשרת');
    eq(await NotificationEvent.countDocuments({ ref_id: p._id, status: 'pending' }), 0, '2d האירוע נסגר');
  }

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} בדיקות עברו`);
}

main()
  .catch(err => { console.error('\n💥', err); failures++; })
  .finally(async () => {
    try { if (server) await new Promise(r => server.close(r)); } catch { /* closing */ }
    try { await mongoose.disconnect(); } catch { /* disconnecting */ }
    try { if (mongod) await mongod.stop(); } catch { /* stopping */ }
    process.exit(failures === 0 ? 0 : 1);
  });
```

- [ ] **Step 2: Run it**

```bash
cd server && node --check scripts/punch-notifications.test.js && node scripts/punch-notifications.test.js
```
Expected: all checks pass. If a `waitFor` times out, check that Task 11/13's exact insertion points match — the most common cause is an event created under the wrong `type` or with the wrong `recipient_id` set (e.g. `branchManagerIds` called with the host branch instead of the employee's home branch).

- [ ] **Step 3: Run the FULL existing test suite one more time — final regression gate**

```bash
cd server && for f in scripts/*.test.js; do echo "=== $f ==="; node "$f" || echo "❌ FAILED: $f"; done 2>&1 | grep -E "===|❌|✅ [0-9]+/[0-9]+"
```
Expected: every suite prints `✅ N/N בדיקות עברו` (or the English equivalent for older suites), nothing prints `❌ FAILED`.

- [ ] **Step 4: Build the client one more time**

```bash
cd client && npx vite build 2>&1 | tail -10
```
Expected: builds clean.

- [ ] **Step 5: Commit**

```bash
git add server/scripts/punch-notifications.test.js
git commit -m "test(push): end-to-end punch notification lifecycle"
```

---

## Self-review notes (already applied above)

- **Spec coverage**: every section of the spec (§4 models, §5 service, §6 job, §7 event wiring table's three rows, §8 native-needs-nothing, §9-10 web client + config, §12 testing) maps to a task above. §11 (explicitly out of scope) has no task, correctly.
- **Type/signature consistency checked**: `createEvent`'s parameter names (`type, ref_collection, ref_id, recipient_id, title, body, url`) are identical across Task 4's implementation and every call site in Tasks 10-13. `branchManagerIds`/`accountantIds` return `string[]` everywhere they're consumed (iterated with `for...of`, never treated as a single id).
- **No placeholders**: every step above either runs a real command or shows the complete code to write — nothing says "add appropriate handling" or defers to another task's text.
