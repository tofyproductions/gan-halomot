# Office email routing ("מי מקבל מה") + "פניות למשרד" — design

Approved with the owner (עמית) on 27.09.2026, in chat.

## Problem

Every email the system sends to the office goes to all admins/accountants by role
(15 call sites, each with its own `User.find`). The owner wants mail by topic:

- עמית (system_admin, tofy10.amit@gmail.com) — only system faults, plus technical and graphics requests.
- אורלי (accountant, tofy10.office@gmail.com) — employees, contracts, payroll; parents/finance.
- בן (system_admin, totofy10@gmail.com) — CEO; everything.
- אלעד (admin_viewer, sharvit82@gmail.com, set 27.09) — employees, contracts, payroll.

There is also no way for staff to ask the office anything in the app. The owner
wants a "contact the office" page where a technical question reaches עמית.

## Part A — topic routing

### Topics

Seven topics. The first three cover the existing automatic mails, the last four the new contact page:

| key | Hebrew | default recipients |
|---|---|---|
| `system_faults` | תקלות במערכת | עמית, בן |
| `hr` | עובדים, חוזים ושכר | אורלי, בן, אלעד |
| `parents_finance` | הורים וכספים | בן, אורלי |
| `contact_tech` | פנייה: תקלה באפליקציה | עמית, בן |
| `contact_graphics` | פנייה: גרפיקה ותמונות | עמית, בן |
| `contact_payroll` | פנייה: שכר, שעות, תלושים ומסמכים | אורלי, בן, אלעד |
| `contact_general` | פנייה: שאלה כללית / אחר | בן |

### Storage

One Setting, `email_routing`:
`{ topics: { <key>: { user_ids: [ObjectId string], extra_emails: [string] } } }`

- It is seeded once in production by a script. Users are resolved by their email address; the script aborts if any of the four is missing.
- There is no code-level default list. When the Setting or a topic is empty, the fallback below applies.

### The one helper — `server/src/services/office-recipients.service.js`

- `TOPICS` — keys, Hebrew labels, and `kind: 'mail' | 'contact'`.
- `officeEmails(topic)` → `string[]`. It returns:
  - routed users who are active, not `is_test_account`, and have a real address (not `@gan-halomot.local` and not the unregistered `ganhalomot.co.il`);
  - plus `extra_emails`;
  - lower-cased and de-duplicated.
- **Fallback:** if the result is empty, return every active real-address system_admin. Nothing goes silent.
- `officeUserIds(topic)` → user id strings, filtered the same way (for push and for inbox visibility). No fallback: an unrouted contact topic is visible only to system_admin (see Part B).
- `candidates()` → the users the grid may list: active, role in system_admin / accountant / admin_viewer, real address.

### Call sites switched (office part only; branch-manager parts unchanged)

| topic | site |
|---|---|
| system_faults | `services/cibusSyncJob.js` `alertIfStale` |
| system_faults | `controllers/agent.controller.js` `maybeAlertClockDown`, `checkStaleAgents` (the admin half of the `$or`; the manager clauses stay) |
| system_faults | `services/faceHealthJob.js`, `services/photoRetentionJob.js` (replaces the `face_alert_email` Setting / `FACE_ALERT_EMAIL` env) |
| system_faults | `controllers/payrollMonth.controller.js` CPA-send-failed mail: the office CC **plus** system_faults |
| hr | `controllers/employmentContracts.controller.js` `notifyAdminsPending`; the signed-contract mail (office part) |
| hr | `controllers/employeeOnboarding.controller.js` `notifyOffice` (office part) |
| hr | `controllers/careers.controller.js` `notifyManagers` (office part) |
| hr | `services/recruitmentDigestJob.js` `officeRecipients` — **drops Setting `accountant_email`**: that is the external CPA, and he was receiving the recruitment digest |
| hr | `services/complianceDigestJob.js` `recipients` (Setting `compliance_alert_emails` is still added) |
| parents_finance | `controllers/leads.controller.js` — only the no-manager fallback |
| parents_finance | `controllers/debtDocuments.controller.js` `adminEmails` |
| parents_finance | `services/reconcileDigestJob.js` `recipients` (Setting `reconcile_alert_emails`, which is עינת, is still added) |

Unchanged:
- the CPA mails (`accountant_emails`, the payslip audit, the signed contract to accounting);
- the hard-coded office CCs (parent agreement copy, payslip audit);
- supplier orders, `emailTest`, platform signup;
- עינת's monthly ClickTac reminder;
- all mail to employees and branch managers.

### Admin UI

- **Panel:** `client/src/components/admin/EmailRoutingPanel.jsx`, rendered in `PermissionsManager.jsx` next to `StoreVersionPanel`.
  - A grid of candidates (rows) × topics (columns) with checkboxes, grouped as "מיילים אוטומטיים" and "פניות למשרד".
  - Per topic, a chips input for extra addresses, with basic email validation.
  - A "שמור" button.
- **API:** `GET/PUT /api/admin/email-routing` in `admin.routes.js` (router already `requireRole('system_admin')`).
  - The PUT validates topic keys, that user ids are candidates, and the email format.

## Part B — "פניות למשרד"

### Model `ContactRequest`

| field | notes |
|---|---|
| `user_id` | sender, required |
| `employee_id` | nullable, via `resolveSelfEmployee`-style lookup |
| `branch_id` | nullable |
| `topic` | one of the 4 contact topics |
| `status` | `open` \| `answered` \| `closed`; open = waiting for the office |
| `messages[]` | `{ at, by, by_name, from_office: Boolean, text, attachment: { storage_key \| data(base64), content_type, name } }` |
| `last_message_at` | |
| `closed_at`, `closed_by` | |

Indexes: `{user_id, last_message_at}`, `{topic, status, last_message_at}`.

### Visibility

- **Sender:** sees her own requests.
- **Office user:** sees topic T iff their id is in `officeUserIds(T)`. system_admin also sees topics that have no routed users, so nothing is orphaned.
- **Branch managers:** get no special access — privacy, since payroll questions live here.

### API — `/api/contact-requests`

All endpoints are authenticated (every role).

| endpoint | who | behavior |
|---|---|---|
| `POST /` | any | multipart: `topic`, `text` (1–2000 chars), optional `file`. Image only (jpeg/png/webp/heic→refuse with a message, as elsewhere), ≤ 10 MB. Stored in the bucket via `storage.service` when configured, else base64. |
| `GET /mine` | sender | her requests, newest activity first |
| `GET /inbox?status=` | office | requests in the caller's visible topics |
| `GET /counts` | office | `{ open }` for the badge |
| `GET /:id` | sender or visible office | one thread |
| `POST /:id/reply` | sender or visible office | `text` + optional `file` |
| `POST /:id/close` | sender or visible office | closes the thread |
| `GET /:id/attachment/:i` | sender or visible office | bytes behind auth |

### Notifications

- **New request, or an employee reply:**
  - email to `officeEmails(topic)` (subject `פנייה חדשה — <topic label> — <name>`, the text, a link to `/contact-inbox`);
  - `createEvent` type `contact_request_new` to each `officeUserIds(topic)`, which is resent hourly until resolved.
- **Office reply:** `resolveEvents(ContactRequest, id)`, then `notifyOnce` type `contact_request_reply` to the sender, url `/contact-office`, status → `answered`.
- **Close:** `resolveEvents`.
- Both new types go in the `NotificationEvent` enum; the `notification-types` test enforces it.

### Viewer gate

אלעד is admin_viewer. Viewer writes are turned into proposals by `authMiddleware` / `decideViewerWrite`. Replying or closing a contact request must be a real write for a viewer who is routed on that topic.

**Verify during implementation:** add `/api/contact-requests` to the viewer write allow-list (the same mechanism that lets viewers use their own self-service routes). The controller's visibility check is the guard.

### Client

- **Tab `contact_office`** → `/contact-office`, group "האזור שלי", `defaultRoles: null` (everyone), on both client and server tabs.
  - Page `employee-portal/ContactOffice.jsx`:
    - a form (4 topic cards, text, optional screenshot);
    - "הפניות שלי" with a status chip;
    - an expandable thread with a reply box and a close button.
- **Tab `contact_inbox`** → `/contact-inbox`, defaultRoles system_admin / accountant / admin_viewer.
  - Page `admin/ContactInbox.jsx`:
    - filter by status (default open);
    - each card shows name, branch, topic, age, last message;
    - the thread has reply and close.
  - Badge via a `useContactInboxCount` hook (polls `/counts` every 60 s) in `Sidebar.jsx` `useBadges` and in `ClassicHeader.jsx`.
- **Icons:** `navIcons.js` and `ClassicHeader` `ICON_BY_TAB`.
- **Help:** `screenHelp.js` entries.
- **Imports:** every JSX name must be imported (the 27.09 crash). Run the imports check.

## Testing

- **Unit** (`server/scripts/*.test.js`, plain assert, registered in `package.json`):
  - `office-recipients` — routing, filtering, fallback, dedupe, no `.local`;
  - `contact-requests` — visibility rules, validation, status transitions (pure helpers extracted);
  - tabs sync test; notification-types test.
- **Stub-based tests** for two switched sites: the recruitment digest no longer includes `accountant_email`, and the face health job uses the topic.
- **E2E in production:** the jobs-off local server recipe (see memory `gan-punch-followup`). A test employee sends a tech request → the routed test office user sees it, the badge counts it → reply → the employee sees the answer → close → all test rows deleted.

## Stages

1. **A1** — helper + Setting + seed script + switch the 12 sites + tests. Deploy.
2. **A2** — admin panel + API. Deploy.
3. **B1** — model, API, notifications, viewer gate + tests. Deploy (dormant: no UI yet).
4. **B2** — both pages, tabs, badge, help. Deploy.
5. **B3** — E2E in production, cleanup, memory.
