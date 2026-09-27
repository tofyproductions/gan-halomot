# Punch Follow-up — Stage 2 (Employee) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The employee side of the punch follow-up:
- a 07:00 push for yesterday's new problems;
- a popup on every app open until she answers;
- three fix flows (missing punch, duplicate labels, empty day);
- a push telling her when the manager decides on a reported punch.

**Architecture:** A new route family `/api/punch-followup` (`mine`, `fix`). It reuses Stage 1's `loadFollowup` for "what is open" and the existing `createPunchRequest` for writing punches, so the clock-word-stands and duplicate guards stay the only gatekeepers. Pure helpers (`missingSide`, `validateLabels`, `pickEmployeePushes`, `pushText`) are unit-tested. The morning push hooks into the existing `punchIssuesDigest.tick`. The client gets one new component plus a deep-link hook in `Updates.jsx` for sick/vacation.

**Tech Stack:** Node/Express/Mongoose, React 18 + MUI, repo `server/scripts/*.test.js` convention.

**Spec:** `docs/superpowers/specs/2026-09-27-punch-followup-design.md` (stage 2) · Stage 1 plan: `2026-09-27-punch-followup-stage1-engine.md`

## Global Constraints

- **Still dormant.** Everything reads `loadFollowup`, which returns nothing while the Setting `punch_followup_start_date` is unset. The go-live date is set only after Stage 3 ships, so that managers can already approve what employees send.
- **Push once.** An employee push is created and immediately marked resolved (`notifyOnce`), because the hourly resend is for things a manager must act on, not for nagging an employee. Each issue key is logged in `PunchFollowupLog` (`employee_push`) and never pushed twice.
- **One gatekeeper per write.** Missing-punch and "worked" fixes go through `createPunchRequest`. They are never written directly.
- **Client:** every JSX component used must appear in that file's import list. An undeclared name builds fine and crashes the screen (27.09 incident).
- **Deviation from the spec:** decision pushes are not written to `PunchFollowupLog`. The log's readers are the reminder UI and push dedupe, and a decision push needs neither.

---

### Task 1: Pure fix helpers

**Files:** Create `server/src/services/punchFollowup/fix.js`, `server/scripts/punch-followup-fix.test.js`. Register `test:punch-followup-fix`.

**Interfaces — produces:**
- `missingSide(existing:{state,hhmm}, hhmm) → 'in'|'out'`
- `validateLabels(labels:[{punch_id,role}], dayPunchIds:string[]) → string|null`
- `pickEmployeePushes(issues, sentKeys:Set, yesterday) → Map<empId, Issue[]>`
- `pushText(issues) → {title, body}`
- `dayLabel(ymd) → 'יום ראשון 28.9'`

Tests cover:
- the side comes from the clock state when known (0 → out, 1 → in), and from time order when unknown (255);
- labels must cover every counted punch exactly once, only in/out/ignore, with equal in/out and at least one pair;
- pushes are only for `view:'fix'` from yesterday, with a user, not already sent;
- the text has a single-issue form per kind and a multi-issue summary.

### Task 2: `notifyOnce` + decision push

**Files:**
- `server/src/services/notification.service.js`: add `notifyOnce` (create + resolve immediately), and export it.
- `server/src/controllers/payroll.controller.js`:
  - export `resolveSelfEmployee`;
  - add `notifySelfReportDecision(p, approved, note)`, called from `approvePunch` when a manager or admin moves a `pending_manager`/`pending` punch forward, and from `rejectPunch` on the plain rejection path;
  - the push goes to the employee's `user_id` only, type `punch_followup_decision`, link `/my-attendance`.

### Task 3: `/api/punch-followup` — `mine` + `fix`

**Files:**
- Create `server/src/controllers/punchFollowup.controller.js` and `server/src/routes/punchFollowup.routes.js`.
- Mount it in `server/src/routes/index.js` next to `/payroll`.

**Endpoints:**
- `GET /mine` returns `{ issues:[{key,kind,date,state,view,punches:[{id,hhmm,state,counted,status,branch_id}],schedule:{start,end}|null}] }` for the logged-in employee. `[]` when there is no linked employee or while the flow is dormant.
- `POST /fix` takes `{issue_key, …}`:
  - It recomputes her issues, and accepts only her own `open` issue: 404 if it isn't hers or doesn't exist, 409 if it is already sent.
  - `missing {time, note}` → `createPunchRequest` for the missing side only, on the branch of the punch that day.
  - `empty_day {action:'worked', in_time, out_time, note}` → `createPunchRequest` with both times.
  - `empty_day {action:'other', text}` → upsert `PunchDayExplanation` as `pending_manager`, then push the managers.
  - `duplicate {labels, note}` → upsert `PunchResolution` as `pending_manager` / `proposed_by_role:'employee'`. Returns 409 if the manager or accountant already owns the day. Then push the managers.
  - Manager pushes use `punch_pending_manager` with `ref_collection` `PunchResolution` / `PunchDayExplanation`, link `/?punch_followup=1`. Stage 3 resolves them.

### Task 4: The 07:00 employee push

**Files:**
- Create `server/src/services/punchFollowup/notify.js` → `sendEmployeeMorningPushes({today})`. It loads all issues, picks the new ones via `pickEmployeePushes`, sends one push per employee (`punch_followup_employee`, link `/?punch_fix=1`), and logs every issue key.
- `server/src/services/punchIssuesDigest.js`: call it right after the daily marker is written, before the "no manager issues → return" exit. Wrap it in a catch, so an employee-push failure never costs the managers their digest.

### Task 5: The employee popup + the sick/vacation deep link

**Files:**
- Create `client/src/components/attendance/EmployeePunchFixPopup.jsx`.
- Mount it in `client/src/components/layout/AppShell.jsx` and `client/src/components/layout/classic/ClassicLayout.jsx`, right after `<MyDecisionsPopup />`.
- `client/src/components/employee-portal/Updates.jsx`: `?open=sick|vacation&date=YYYY-MM-DD` opens that dialog with the dates filled in.

**Behavior:**
- Loads `/punch-followup/mine` on login.
- Opens when there is something with `view:'fix'`, unless `sessionStorage['punchFixSnoozed']` is set. `?punch_fix=1` forces it open.
- "אחר כך" snoozes until the next app open.
- One card per issue:
  - **missing:** the recorded time, one time field and a note.
  - **duplicate:** every punch with a כניסה / יציאה / בטעות toggle. Default: first = in, last = out, the rest = ignore.
  - **empty_day:** "עבדתי" (two time fields, pre-filled from the commitment) or "לא עבדתי" → מחלה / חופשה (navigate to the Updates dialog) / אחר (text).
- A small "נשלח לאישור המנהלת ✓" list for `view:'sent'`.

### Task 6: Ship

- Run: fix + engine + model + notification-types + digest + clock-word-stands + manager-first tests, a load of every touched controller, and `vite build`. Also grep each new client file's `<Component` names against its imports.
- Push, then wait for `/api/health` to show the new commit.
- In production:
  - `GET /api/punch-followup/mine` returns `{issues:[]}` (dormant);
  - the app loads with no console errors;
  - "ההחתמות שלי" and "עדכונים" still open.
- Update memory.
