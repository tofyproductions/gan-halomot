# Admin viewer role ("מנהל מערכת - לצפייה בלבד") — design

Date: 2026-09-07. Branch: `feat/admin-viewer-role`. Status: approved in chat, pending implementation.

## Why

Elad Burkov is a partner in the company. He currently runs the Tel Aviv branch
because it has no manager, but he is part of company management and needs to
**see everything a system admin sees, across every branch**. He must not be
able to change anything outside his own branch(es) directly: every such change
goes to the accountant or the system admin for approval, the way a branch
manager's "עדכון שכר" does today. Inside the branches he manages he keeps the
full branch-manager powers, including their existing approval chains.

Nothing about the seven existing roles changes.

## The role

- New value in the `User.role` enum: `admin_viewer`. Hebrew label everywhere:
  **מנהל מערכת - לצפייה בלבד**.
- The role is a regular role: it appears in the role list, in the
  "הרשאות לפי תפקיד" chip rows, and can be given to anyone in the future.
- `managed_branch_ids` (already on the user) is the "second role": a viewer with
  a non-empty list acts as **branch_manager** for those branches. A viewer with
  an empty list is a pure viewer. Elad = `admin_viewer` + `[Tel Aviv]`. When Tel
  Aviv gets a real manager, clear his list.

## Server behaviour

All decisions live in `server/src/middleware/auth.js` (`requireRole`) and
`server/src/utils/branch-scope.js`. Controllers are not touched for the
read/write split; they keep working on `req.user.role` as today.

Definitions: a **read** is `GET`/`HEAD`/`OPTIONS`. Everything else is a
**write**.

### Reads

- `requireRole(...roles)`: a viewer passes wherever `system_admin` would pass,
  **except** under `/api/admin` (users, permissions, role-tab settings, deletion
  requests). There the viewer gets the usual 403.
- `resolveBranchScope(req)` returns `null` (all branches) for a viewer on a
  read, so lists, dashboards, payroll tables and payslips cover every branch,
  exactly like the admin sees them.
- `requireBranchScope` lets a viewer through (they always have a scope).
- Multipart never matters for reads.

### Writes

In `requireRole`, for a user whose role is `admin_viewer` on a write:

1. `/api/admin/*` → 403, no proposal. Same for anything else that is
   `system_admin`-only and not a data change (none known today besides
   `/api/admin`; the exclusion list is one constant).
2. Request is `multipart/form-data` → 403 with a Hebrew message saying files
   cannot be queued for approval; upload in your own branch or ask the admin.
   (Own-branch multipart on a route that allows `branch_manager` still passes
   through rule 3, because the controller's scope check accepts it.)
3. The route allows `branch_manager` **and** the viewer has managed branches →
   the request continues with `req.user.role = 'branch_manager'` for the rest
   of this request only (the JWT is untouched). `resolveBranchScope` on a write
   returns the viewer's `managed_branch_ids`, so every existing branch-manager
   path — scope checks, punch `pending_accountant`, payroll change requests,
   rate change requests — behaves exactly as for a real branch manager.
   The middleware also flags the request (`req.viewerFallback = true`). If the
   controller then answers **403** (the target was outside the viewer's
   branches), a small `res.json` wrapper installed by the middleware converts
   that reply into a proposal (rule 4) instead of the 403. A 403 is the only
   status converted; 400/404/409/500 pass through unchanged.
4. Otherwise → **propose**: store a `ProposedChange` and reply
   `202 { proposed: true, id, message: 'השינוי נשמר וממתין לאישור <approver>' }`.
   Nothing is written to the target collection.

Rule 3 exists so that a viewer who is also a branch manager keeps the ordinary
manager experience in his own branch, and so that the payroll table's existing
"stage → change request" flow serves him for every branch (see below).

### `ProposedChange` model

```
requested_by, requested_by_name, requested_role ('admin_viewer')
method, path (originalUrl incl. query), host, body (Mixed), headers subset (content-type)
screen_label   Hebrew screen name, derived from the path prefix
summary        [{ key, label, value }] — top-level scalar fields of the body,
               labels from a small server-side map (payroll FIELD_LABELS reused,
               common keys like note/date/amount), raw key otherwise
branch_id, branch_name   best-effort from body.branch_id / query.branch / params
approver       'accountant' | 'system_admin' (routing below)
status         'pending' | 'approved' | 'rejected' | 'failed'
decided_by, decided_by_name, decided_at, decision_note
apply_status, apply_error   HTTP status and error text of the replay
created_at, updated_at
```

Indexes: `{status:1, created_at:-1}`, `{requested_by:1, created_at:-1}`.

Approver routing by path prefix: `/api/payroll`, `/api/payroll-month`,
`/api/salary-requests`, `/api/rate-changes`, `/api/employment-contracts`,
`/api/collections`, `/api/form-101`, `/api/employee-letters`,
`/api/branch-pricing`, `/api/suppliers` → `accountant`; everything else →
`system_admin`. Routing only picks who is nudged; **both** roles may decide any
proposal (the user asked for "הנה"ח או מנהל מערכת").

Screen label: one server-side map path prefix → Hebrew, mirroring the labels in
`client/src/config/tabs.js` (the server has no such map today).

### Applying an approved proposal (replay)

`POST /api/proposed-changes/:id/decide { decision: 'approve'|'reject', note }`
guarded by `requireRole('system_admin','accountant')`.

On approve the server re-issues the stored request **against itself**
(`http://127.0.0.1:${PORT}` + stored path) with:

- the original `Host` header (tenant resolution in `platform/resolve.js` is host
  based),
- a short-lived JWT (5 minutes) minted for the **approver**, so the change is
  applied with the approver's authority and audit trail (`decided_by` on
  punches, `requested_by` on nothing — it is a direct write now),
- header `x-proposed-change: <id>` for logging,
- the stored body as JSON.

The replay's HTTP status is stored. 2xx → `approved`. Anything else →
`failed` with `apply_error`; the row stays visible with a "נסה שוב" action
and the error text, and the requester sees it as rejected-with-reason. A
proposal applied days later is applied on top of the current state (last
write wins); the approver sees the stored field values, not a live diff. This
is the accepted trade-off of the generic mechanism.

Reject → `rejected`, nothing is replayed.

### Routes

```
GET  /api/proposed-changes            admin, accountant: all (filter ?status=), viewer: own only
GET  /api/proposed-changes/count      pending count for the badge (admin/accountant)
POST /api/proposed-changes/:id/decide admin, accountant
```

`GET /api/my-decisions` (decisions.controller) gains a fifth source: the
requester's decided proposals, `kind: 'proposed'`, `kind_label: 'שינוי לאישור'`,
title = screen label, lines = summary rows, status labels reused.

### Payroll specifics

- `PayrollMonthTable` already stages for anyone who is not admin/accountant;
  a viewer therefore stages and sends a `PayrollChangeRequest` for **any**
  branch. `createChangeRequest` must accept rows from every branch when the
  requester is a viewer (scope = all for that one endpoint), and
  `listChangeRequests` returns a viewer's own requests only.
- Punches in the viewer's own branch: manager chain (`pending_accountant`).
  Punches in another branch: the controller's scope check returns 403 → rule 3
  turns it into a proposal → on approval the replay runs as the accountant and
  the punch is `approved` directly. Matches "ישר לאישור הנה"ח".
- Employee card / rates in another branch: same path (proposal or the existing
  `RateChangeRequest` when the route allows managers).

## Client behaviour

- `useAuth`: add `isViewer`. `canSeeAllBranches` includes viewers.
  `isManager` stays `branch_manager || isAdmin`; add
  `managesBranch(branchId)` = viewer/manager with that id in
  `managed_branch_ids` (admin → true) for edit-button decisions.
- `tabs.js`: `admin_viewer` added to `defaultRoles` of every tab that lists
  `system_admin`. No new tab ids for users/permissions exist; those routes stay
  `roles={['system_admin']}` in `App.jsx`, so the viewer never reaches them.
  The payroll `settings` sub-tab stays admin-only.
- Role labels: `PermissionsManager.jsx` `ROLE_LABELS`, `admin.controller.js`
  `ROLES`/`ALLOWED_ROLES` (collapse the duplicate into one export), `User.js`
  enum.
- Branch selector: "כל הסניפים" available to viewers (`useBranch`, `Header`).
- **Edit affordances**: a sweep of components that use `isAdmin`. Two cases:
  - `isAdmin` gates *visibility of data* (sections, columns, totals, filters):
    switch to `isAdmin || isViewer` so the viewer sees what the admin sees.
    This is the case that matters and is done exhaustively.
  - `isAdmin` gates an *edit control* (save/delete/approve buttons): leave it
    hidden for the viewer where the control is admin-only, and leave it visible
    where managers also have it. No per-row hiding by branch. A viewer who
    presses a visible control outside his branch gets a 202 and the toast
    below, so a missed screen degrades to "saved for approval", never to a
    silent write and never to a hard error.
- `client/src/api/client.js` response interceptor: a `202` with
  `data.proposed === true` shows `toast.info(data.message)` and resolves
  normally; screens keep their optimistic state until the next fetch, which is
  acceptable for v1.
- New screen **"שינויים ממתינים לאישור"** (tab id `proposed_changes`, group
  ניהול, roles `system_admin`, `accountant`): list of pending proposals with
  requester, screen, branch, summary rows, note; approve / reject with note;
  failed rows show the error and "נסה שוב". Badge with pending count, polled
  every 60s like the payroll change-request badge. Decided history below.
- The viewer's own outcomes surface in the existing `MyDecisions` popup/tab.

## Setting up Elad

Done through the existing permissions screen after deploy: role →
"מנהל מערכת - לצפייה בלבד", managed branches → תל אביב. No migration script.
His JWT must be re-issued (he logs in again).

## Out of scope

- Live "before/after" diffs for arbitrary screens.
- File uploads outside the viewer's branches.
- Push/email notification to approvers (the system has none for approvals
  today; badges and the decisions popup are the channel).
- Any change to what the seven existing roles can do.

## Testing

Server (`node scripts/*.test.js` style, registered in `server/package.json`):

1. `requireRole` matrix: viewer read on admin-allowed route → pass; viewer read
   under `/api/admin` → 403; viewer write on admin-only route → 202 proposal;
   viewer write on manager-allowed route with managed branches → continues as
   `branch_manager`; controller 403 under the flag → 202 proposal; multipart
   write → 403; every existing role unchanged (parametrised over the seven).
2. `resolveBranchScope`: viewer read → `null`; viewer write → managed list.
3. Approver routing and screen label from path.
4. Replay: approve → stored request re-issued with approver token and original
   host; non-2xx → `failed` with error; reject → nothing issued.
5. `my-decisions` includes decided proposals for the requester.

Manual pass with a test user in the new role on the main screens (dashboard,
employees, payroll table across two branches, attendance fix in own and other
branch, settings, an admin-only write) before Elad's account is switched.

## Rollout

Work on `feat/admin-viewer-role`. Merge to `main` (auto-deploys to Render)
only after the manual pass and the user's go-ahead. The field Pis are on their
own branches and do not consume these routes.
