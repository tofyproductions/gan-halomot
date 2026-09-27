# Punch Follow-up — Stage 3 (Manager) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The branch manager's side of the punch follow-up:
- a daily popup listing her branch's open problems, in two sections: "ממתינים לאישורך" and "לא טופלו ע״י העובדת";
- approve or reject what the employee sent;
- fix it herself;
- remind the employee by WhatsApp or push, at most once a day per issue;
- a floating chip while the popup is closed;
- the 07:00 digest counting by the new engine once the flow is live.

**Architecture:** New endpoints on the same `/api/punch-followup` router: `manager`, `decide`, `fix-as-manager`, `remind`. Every write re-reads the manager's in-scope issues and **delegates to the existing guarded handlers** through a small `invoke(handler, req)` adapter:
- `approvePunch` / `rejectPunch` for reported punches;
- `resolvePunchDay` for duplicate labels (a manager call upserts `status:'pending'`, which is exactly "approved by the manager → accountant queue");
- `createManualPunches` for her own missing/worked entries (manager path → `pending_accountant`).

Scope, the manager-first rule, dedupe and notifications therefore stay in one place each. The card editors move to a shared `PunchFixCards.jsx`, used by both popups.

**Spec:** `docs/superpowers/specs/2026-09-27-punch-followup-design.md` (stage 3) · earlier plans: stage 1 and stage 2 in this folder.

## Global Constraints

- **Manager scope** = `resolveBranchScope(req)`. `null` means all branches (system_admin / accountant); an array means those branches. Issues are loaded with `employeeFilter: { branch_id: { $in: scope } }`.
- **What each action accepts:**
  - `decide` only acts on `visibility.manager === 'awaiting'`;
  - `fix-as-manager` and `remind` act on `'unhandled'` or `'awaiting'`;
  - anything else → 404 / 409.
- **Push resolution:** a decision on a `PunchResolution` / `PunchDayExplanation` resolves its `punch_pending_manager` events (`resolveEvents`); punch events are already resolved by `approvePunch` / `rejectPunch`.
- **Employee push on decisions:** for duplicate/explanation decisions, `notifyOnce` of `punch_followup_decision` goes to the employee's `user_id`. Punch decisions already push from Stage 2.
- **Reminder push:** at most one per issue per Israel day, enforced against `PunchFollowupLog` (`manager_push`).
- **Popup behavior:** mounted in both layouts for `branch_manager` and `admin_viewer`.
  - Auto-open once a day (`localStorage['punchFollowupDismissedOn']`); `?punch_followup=1` forces it.
  - The chip shows whenever the popup is closed and something is open.
- **Imports:** every JSX component in the new files must appear in the import list (the 27.09 crash).
- **Deviation from the spec (kept deliberately):** `PunchIssuesBanner` is **not** removed for branch managers. It is session-dismissable, still correct, and removing it before go-live would leave managers with nothing while the flow is dormant.

---

### Task 1: `invoke` adapter + `GET /manager`
- `server/src/services/punchFollowup/invoke.js`: `invoke(handler, req, {params, body, query})` → `Promise<{status, body}>`. Uses `Object.create(req)`, so `user` / `headers` / `get()` survive.
- `punchFollowup.controller.js`:
  - `managerIssues(req)`: scope → `loadFollowup` → filter `visibility.manager`.
  - `describeForManager(issues, employeesById)`: per employee, the day's punches (with `manual_note`), the commitment hours, the pending resolution labels, the pending explanation text, pending sick/vacation requests covering the day, the last reminder from the log, `days_open`, name / phone / branch name.
  - `GET /manager` → `{ active, awaiting:[…], unhandled:[…] }`.

### Task 2: `POST /decide`
- `{issue_key, approve, reason}`, only on `awaiting`:
  - pending reported punches → `invoke(approvePunch | rejectPunch)` for each; the first failure is returned as-is;
  - duplicate with a `pending_manager` resolution:
    - approve → `invoke(resolvePunchDay, {employee_id, date, labels, note})`;
    - reject → delete the resolution (only while still `pending_manager`);
    - both → `resolveEvents` + employee decision push;
  - explanation → `accepted` / `rejected(+reason)` → `resolveEvents` + employee decision push;
  - a pending sick/vacation request → 409 "החלטה במסך הבקשות" (the card links there instead).

### Task 3: `POST /fix-as-manager` + `POST /remind`
- `fix-as-manager`:
  - `missing {time}` → `invoke(createManualPunches, {employee_id, date, [side]:time, branch_id})`;
  - `empty_day worked` → both times;
  - `empty_day other {text}` → `PunchDayExplanation` `accepted` (decided_by = her);
  - `duplicate {labels}` → `invoke(resolvePunchDay)`.
- `remind {issue_key, channel}`:
  - `whatsapp` → `{url}` (`wa.me` + Hebrew text), then log `manager_whatsapp`;
  - `push` → the once-a-day check, then `notifyOnce(punch_followup_reminder)` to her `user_id`, then log `manager_push`. No `user_id` → 400 with a "use WhatsApp" message.
- Pure helper `reminderText(kind, date, firstName)` in `fix.js`, with tests.

### Task 4: 07:00 digest by the new engine
- `notify.managerDigestCounts({today})` → `null` while dormant, otherwise `Map<branchId,{awaiting, unhandled}>`.
- In `tick`: when it is not null, the per-branch manager push reads "N ממתינים לאישורך · M לא טופלו", links to `/?punch_followup=1`, and skips branches with nothing. When it is null, the old digest is unchanged. The office summary is unchanged either way.
- Digest test: the stub returns `null` for the existing cases; add one case with counts and assert the new text and link.

### Task 5: Client
- `client/src/components/attendance/PunchFixCards.jsx`: `MissingCard`, `DuplicateCard`, `EmptyDayCard` (with a `forManager` wording prop that hides sick/vacation), `dayLabel`, `KIND_TITLE`. `EmployeePunchFixPopup` imports them.
- `client/src/components/attendance/ManagerPunchFollowupPopup.jsx`: the two sections.
  - Awaiting cards show what was reported, with ✓ אשר / ✗ דחה (+ reason); a pending request shows a link to `/employee-requests`.
  - Unhandled cards show days open and the last reminder, with "אתקן בעצמי" (the shared card editors), "📲 וואטסאפ" (opens the returned URL) and "🔔 פוש".
  - A floating chip.
- Mount it in `AppShell.jsx` + `ClassicLayout.jsx`.

### Task 6: Ship + go-live readiness
- Run all tests, the controller loads, `vite build`, the imports check. Push, then check health.
- Production checks:
  - `GET /manager` → `{active:false, awaiting:[], unhandled:[]}`;
  - no console errors;
  - the payroll and attendance screens open.
- Update memory. The go-live date is set only with the owner's word, followed by an end-to-end run with a test employee.
