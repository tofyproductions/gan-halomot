# Push notifications for branch managers — design

Date: 2026-09-10
Branch: `feat/push-notifications` (worktree `gan-halomot-notifications`)
Status: approved by user in chat 2026-09-10, pending written-spec review

## 1. Problem

Managers miss things that need a decision: a new parent lead, a punch
correction waiting on their approval, an employee's own punch report waiting
on their approval. Email exists for some of these today but is easy to miss.
The ask: a push notification that reaches the manager the moment the event
happens (or the next time they open the app), repeats every hour on its own
until someone actually resolves the underlying item, and disappears
everywhere the instant it's resolved.

## 2. Decisions already made (user, in chat)

1. Build the real thing (Web Push via VAPID), not a cheap in-tab-only
   version, and not a third-party push vendor.
2. Cover, in v1: new leads, cross-branch punch corrections (built earlier
   this session), and the ordinary punch approval queue
   (`pending_manager`/`pending_accountant`).
3. If a manager does nothing at all — no click, no dismissal — the same
   notification is sent again after exactly one hour, forever, until the
   underlying item is resolved by someone. This holds regardless of whether
   she explicitly asked to be reminded later; there is therefore no need for
   a "remind me later" action button in the notification itself — tapping
   the notification just opens the relevant screen.
4. **Mid-design discovery that changed scope**: this repo already has a full
   native mobile app (Capacitor-wrapped web client, `client/android` +
   `client/ios`, commits `fbfb66e`..`eafa39b`, 2026-09-06/07) with working
   FCM push *registration* (`server/src/controllers/push.controller.js`,
   `server/src/models/PushSubscription.js`, `server/src/services/fcm.service.js`)
   already wired into staff login/logout. The **send** side (`fcm.service.js`'s
   `sendPush`) has zero callers anywhere — a dead capability. The native app
   itself is not yet installed on any manager's phone (still pre-store-approval).
   Decision: build both channels — send through the existing dormant FCM
   pipeline (for whenever the app is installed) **and** build browser Web
   Push (for right now, on the website) — so a manager gets pushes through
   whichever channel she actually has, and both channels a fallback for the
   other.
5. Email (leads, cross-branch punch) stays exactly as it is today. Push is
   additive, not a replacement. A closed browser/computer or an uninstalled
   app simply gets no push — email is what still reaches her.

## 3. Architecture

One generic notification layer that any part of the app can raise an event
into, decoupled from how it gets delivered:

```
event happens (lead created, punch staged, punch decided)
        │
        ▼
notification.service.js: createEvent() / resolveEvents()
        │
        ▼
   NotificationEvent (one row per recipient, status: pending/resolved)
        │
        ▼
resend job (every 5 min, node-side setInterval — same pattern as the
existing jobs in server/src/index.js): finds rows due for a(nother) send
(next_send_at <= now), sends, sets next_send_at = now + 1h
        │
        ├──▶ fcm.service.js sendPush()      (existing PushSubscription rows: android/ios)
        └──▶ web-push npm package            (new WebPushSubscription rows: browser)
```

Resolving is decoupled from sending: whatever handler already changes a
lead's status away from `'new'`, or decides a punch (approve/reject, any
stage), also calls `resolveEvents({ ref_collection, ref_id })`, which closes
**every** open `NotificationEvent` row for that document — including rows
belonging to a different manager who saw the same thing and didn't act. This
mirrors the existing "first to decide, closes it" rule already built for
cross-branch punch approval.

## 4. Data models

### 4.1 `NotificationEvent` (new)

```js
{
  type: { type: String, enum: ['new_lead', 'punch_pending_manager', 'punch_pending_accountant'], required: true },
  ref_collection: { type: String, required: true },   // 'Lead' | 'Punch'
  ref_id: { type: ObjectId, required: true },          // the Lead/Punch _id
  recipient_id: { type: ObjectId, ref: 'User', required: true },
  title: { type: String, required: true },
  body: { type: String, required: true },
  url: { type: String, default: '' },                  // deep link the client opens on tap
  status: { type: String, enum: ['pending', 'resolved'], default: 'pending', index: true },
  created_at, // timestamps
  last_sent_at: { type: Date, default: null },
  next_send_at: { type: Date, required: true, index: true }, // now, initially — sends immediately
  resolved_at: { type: Date, default: null },
}
```
Indexes: `{ status: 1, next_send_at: 1 }` (the resend job's query),
`{ ref_collection: 1, ref_id: 1 }` (resolveEvents' query).

One row per `(type, ref_id, recipient_id)` — `createEvent` upserts rather
than duplicating if one is already pending for the same triple (e.g. two
managers get two separate rows for the same lead; the same manager doesn't
get a second row if she's still sitting on the first one).

### 4.2 `WebPushSubscription` (new)

```js
{
  user_id: { type: ObjectId, ref: 'User', required: true, index: true },
  endpoint: { type: String, required: true, unique: true },
  keys: { p256dh: String, auth: String },
  created_at, updated_at,
}
```
Deliberately separate from the existing `PushSubscription` (FCM/native)
rather than merged into it — different shape (`endpoint`+`keys` vs.
`fcm_token`+`platform`), different send call (`web-push` vs. `fcm.service`),
and merging them would mean touching the existing, already-shipped native
push model for a browser feature it has nothing to do with.

## 5. `server/src/services/notification.service.js` (new)

```js
async function createEvent({ type, ref_collection, ref_id, recipient_id, title, body, url })
// Upserts one NotificationEvent (pending, next_send_at = now).

async function resolveEvents({ ref_collection, ref_id })
// Marks every matching pending NotificationEvent resolved.

// Internal, called by the resend job only:
async function deliver(event)
// Sends to every PushSubscription AND WebPushSubscription row for
// event.recipient_id. FCM: server/src/services/fcm.service.js#sendPush,
// deleting the row on { unregistered: true } (already-implemented
// behavior in that file, just never invoked until now). Web: `web-push`
// npm's webpush.sendNotification(subscription, payload), deleting the row
// on a 404/410 response (the standard "subscription gone" signal).
```

## 6. Resend job

`server/src/index.js`, alongside the existing job registrations, guarded by
the same `DISABLE_JOBS` env check:
```js
async function runNotificationResend() {
  const due = await NotificationEvent.find({ status: 'pending', next_send_at: { $lte: new Date() } }).lean();
  for (const ev of due) await notificationService.deliver(ev); // sets last_sent_at/next_send_at inside
}
setInterval(runNotificationResend, 5 * 60 * 1000);
```
Every 5 minutes is the polling granularity; the 1-hour repeat is enforced by
`next_send_at`, not by the poll interval.

## 7. Event wiring — v1's three sources

All at exact existing call sites, no new business logic beyond the
create/resolve calls:

| Event | Created at | Recipients | Resolved at |
|---|---|---|---|
| `new_lead` | `leads.controller.js#publicSubmit`, next to the existing `notifyNewLead(...)` call | same set `notifyNewLead` already emails (branch's `branch_manager`s, falling back to `system_admin`) | `leads.controller.js#update`, when `status` changes away from `'new'` |
| `punch_pending_manager` | `payroll.controller.js#createManualPunches` (line ~2130, when `approvalStatus === 'pending_manager'`) **and** `#editPunch`'s cross-branch staging branch (line ~3059) | normal case: the punch's own branch's managers (same query `leads.controller.js` uses, scoped to `p.branch_id`); cross-branch case: the **employee's home branch**'s managers (same recipients the existing cross-branch email already reaches) | `payroll.controller.js#approvePunch` and `#rejectPunch`, whenever a decision is made at the manager stage (both the plain and the cross-branch branch already added this session) |
| `punch_pending_accountant` | `#createManualPunches` (manager-authored punch, `approvalStatus === 'pending_accountant'` immediately) **and** `#approvePunch`'s manager→accountant transition (plain stage-1 approval, and cross-branch manager-stage approval alike) | every `User` with `role: 'accountant'` | `#approvePunch`/`#rejectPunch`'s final decision |

Two logical stages (`punch_pending_manager`, `punch_pending_accountant`)
cover both the plain approval queue and the cross-branch flow — the cross-
branch case only differs in *who* the manager-stage recipients are, not in
event shape. This is a deliberate simplification versus treating cross-
branch as a fourth type.

**Fallback recipients**: whenever a `punch_pending_manager` lookup (plain or
cross-branch) returns zero active managers for the relevant branch, the
event's recipients fall back to every `system_admin` user instead — matching
the identical fallback already used by `leads.controller.js#notifyNewLead`
and by the cross-branch approval gate itself (`crossBranchEditGate`, which
already lets `system_admin`/`accountant` act directly when there is no home
manager to wait for). Without this, a branch with no manager would simply
never get a push for that stage, silently.

## 8. Client — native (FCM)

**No changes.** `client/src/utils/nativePush.js` already registers a device
on every staff login inside a native (Capacitor) build; `sendPush` merely
needed a caller, which now exists server-side. Nothing here to build.

## 9. Client — web (browser)

- `client/public/sw.js` (new): minimal service worker — a `push` listener
  that reads the JSON payload (`{title, body, url}`) and calls
  `self.registration.showNotification(title, {body, data:{url}})`; a
  `notificationclick` listener that closes the notification and
  `clients.openWindow(url)`.
- Registered once at app boot (`client/src/main.jsx` or `App.jsx`), guarded
  by `'serviceWorker' in navigator && !Capacitor.isNativePlatform()` — the
  native shell has no use for a service worker (per the existing comment in
  `fcm.service.js` explaining why the web build ships none today; this adds
  one, scoped to non-native only).
- A "הפעילי התראות בדפדפן" button — settings/profile screen, visible to
  `system_admin`/`branch_manager`/`accountant` (the same roles that see
  leads/punches). On click: `Notification.requestPermission()` →
  `registration.pushManager.subscribe({ userVisibleOnly: true,
  applicationServerKey: <VAPID public key> })` → `POST /api/push/register-web`
  with `{ endpoint, keys }`. A parallel `unregister-web` for a toggle-off.
- New env-delivered config: `GET /api/config/vapid-public-key` (or folded
  into whatever config endpoint the client already loads at boot) so the
  public key isn't hardcoded in the bundle.

## 10. New/changed env vars

- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (a `mailto:`
  address) — generated once via `web-push generate-vapid-keys` or
  `webpush.generateVAPIDKeys()`, set on Render. Missing → web push is a
  silent no-op, matching the SMS/email/FCM "unconfigured = no-op" pattern
  everywhere else in this codebase.
- `FCM_SERVICE_ACCOUNT` already exists in `env.js`; its actual presence on
  Render could not be verified from the repo (per commit `ef13318`'s note,
  "set on Render per the client, unconfirmed") — **needs confirming by the
  user directly in the Render dashboard** before the native channel can be
  trusted to work; the web channel does not depend on it at all.

## 11. Explicitly out of scope for v1

- Any event type beyond the three above (employee change requests, תמ"ת
  alerts, etc.) — can reuse the same `createEvent`/`resolveEvents` calls
  later, no infra change needed.
- A "remind me later" action button inside the notification — redundant
  given decision 3 above (it already always comes back in an hour).
- iOS APNS — the existing native push commit already notes iOS is wired
  identically to Android in code but untested (no `GoogleService-Info.plist`
  yet); out of scope here, inherited as pre-existing incompleteness, not
  something this feature needs to fix.
- Any in-app notification center / bell / history list — v1 is push-only;
  the existing per-screen badges (leads count, punch pending queues) remain
  the in-app source of truth for what's still open.

## 12. Testing plan

Same pattern as every other feature built this session: a real Node script
booting the real Express app against `mongodb-memory-server`, with
`sms.service`/`email.service`-style `require.cache` stubs for `fcm.service`
and the `web-push` package so no real push provider is touched. Verifies:
event creation on all three triggers with the right recipients, no
duplicate row for a manager who already has one pending, resolution closing
every recipient's row at once, and the resend job's `next_send_at` math
(simulate time by writing an already-due `next_send_at` directly rather than
waiting a real hour).
