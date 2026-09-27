# Email Routing — Stage A1 (helper + seed + switch sites) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Every office email goes to the recipients of its topic (Setting `email_routing`) instead of "every admin by role".

**Architecture:** One service, `server/src/services/office-recipients.service.js`, owns the topic list, the Setting, the filtering (active, not a test account, real address) and the system_admin fallback. The 12 sites call `officeEmails(topic)` for their OFFICE recipients. The branch-manager halves stay untouched.

**Tech Stack:** Node/Mongoose; tests in `server/scripts/*.test.js` (plain assert, mongodb-memory-server).

**Spec:** `docs/superpowers/specs/2026-09-27-email-routing-and-contact-design.md` (Part A).

## Global Constraints
- Topics: `system_faults`, `hr`, `parents_finance`, `contact_tech`, `contact_graphics`, `contact_payroll`, `contact_general`.
- Setting value shape: `{ topics: { <key>: { user_ids: [string], extra_emails: [string] } } }`.
- A real address:
  - matches `x@y.z`;
  - does not end with `@gan-halomot.local` or `@ganhalomot.co.il`.
- A live user: `is_active != false` and `is_test_account != true`.
- An empty topic in `officeEmails` falls back to live system_admins with real addresses.
- `dispatchEmail` gets `to` as a comma-joined string at every switched site.
- Push recipients are NOT changed in this stage (email only).

### Task 1: service + tests
- `office-recipients.service.js`: `TOPICS`, `ROUTING_KEY`, `isRealEmail`, `officeEmails(topic)`, `officeUserIds(topic)`, `candidates()`, `readRouting()`. Unknown topic → throws.
- `scripts/office-recipients.test.js` (memory Mongo). It checks:
  - routing;
  - dedupe and lower-casing;
  - `.local` / fake-domain / inactive / test-account filtered out;
  - `extra_emails` included;
  - the fallback when the topic is empty;
  - an unknown topic throws;
  - `officeUserIds` has no fallback.
- Register `test:office-recipients`.

### Task 2: switch the sites
| topic | sites |
|---|---|
| system_faults | `cibusSyncJob.alertIfStale`; `agent.controller` `maybeAlertClockDown` + `checkStaleAgents` (managers via `branchManagerClauses`, office via topic); `faceHealthJob.recipient`; `photoRetentionJob` cap alert; `payrollMonth` accountant-send failure (office CC + topic) |
| hr | `employmentContracts.notifyAdminsPending`; the signed-contract mail; `employeeOnboarding.notifyOffice`; `careers.notifyManagers` (email only); `recruitmentDigestJob.officeRecipients` (drops Setting `accountant_email`); `complianceDigestJob.recipients` (+`compliance_alert_emails`) |
| parents_finance | `leads.notifyNewLead` fallback; `debtDocuments.adminEmails`; `reconcileDigestJob.recipients` (+`reconcile_alert_emails`) |

- Update the existing tests that configured `face_alert_email`: seed `email_routing` instead.
- Run every affected test file, check that the controllers load, commit.

### Task 3: seed script + ship
- `scripts/seed-email-routing.js`: resolves the 4 people by email and writes the defaults.
  - Dry run by default; `--apply` writes.
  - Refuses to overwrite an existing Setting without `--force`.
- Push → health → run the seed with `--apply` on production → print the resolved recipients per topic.
