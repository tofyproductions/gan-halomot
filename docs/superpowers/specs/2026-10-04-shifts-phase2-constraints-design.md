# סידור עבודה — שלב 2: אילוצים (design)

Source: grill-me session with עמית, 2026-10-04 (decisions recorded in memory
`gan-shifts-planning`). Builds on phase 1
(`2026-10-04-shifts-phase1-design.md`, live on main 157cc1e).

## What an employee can submit

From "המשמרות שלי" → tab "האילוצים שלי". Types:

| type | meaning | required fields |
|---|---|---|
| `day_off` | בקשת יום חופש | date, details (reason) |
| `partial` | היעדרות זמנית בטווח שעות | date, from_hhmm < to_hhmm, details |
| `sick_expected` | יום מחלה צפוי (ניתוח, אשפוז יום…) | date, details |
| `other` | אחר | date, details |
| `move_day` | לעבוד ביום החופש שלי במקום ביום הרגיל | date (day given up), target_date (day she will work) |
| `swap` | החלפה עם עובדת אחרת | date, swap_mode `handover` (colleague takes her shift) or `mutual` (+ target_date: the day she works instead of the colleague), and either colleague_id or broadcast=true |

Up to 3 attachments (pdf/jpg/png, ≤10MB each) on any type.

## Submission window

- A date in the current week or earlier → refused.
- A date in next week → allowed until **Thursday 18:00 (Israel)** of the current week; after that refused ("ההגשה לשבוע הבא נסגרה ביום חמישי ב-18:00").
- A date further ahead → allowed any time ("far future").
- For move_day/swap mutual the earliest of the dates decides.

## Statuses

`pending_colleague` → (colleague accepts) `open` | (declines) `declined`
`pending_broadcast` → (manager approves sending) `broadcast` → (manager picks a volunteer) `accepted`
`open` → `accepted` | `rejected`
any non-final → `cancelled` (by the employee)

Final: `accepted`, `rejected`, `declined`, `cancelled`.

## Manager

- On the rota board: a panel lists the week's constraints that need action
  (`open`, `pending_broadcast`, `broadcast`) with: אישור / דחייה (reason
  required) / אישור שליחה לכל הסניף / בחירת מתנדבת (volunteers listed with
  "פנויה ביום הזה" when she has no entry that day). Cells of an employee with
  a constraint on that day carry an alert mark.
- "אילוצים עתידיים" dialog: every constraint of weeks after next; she may
  decide them early. Accepting a far-future constraint requires an explicit
  confirmation ("הפעולה סופית — העובדת תקבל הודעה").
- Accepted constraints are final. An accepted `day_off`/`sick_expected`/
  `move_day`/`swap` blocks placing the employee on that date (and `partial`
  blocks entries overlapping its hours) — the save is refused.
- On "סגירת סידור" (publish): every `open` constraint of the week that the
  rota already respects is auto-accepted (rules below); if any constraint of
  the week is still unresolved (`open` not respected, `pending_broadcast`,
  `broadcast`) the publish is refused with the count — she must decide them.
- Accepting `day_off` creates an EmployeeRequest `vacation`, accepting
  `sick_expected` creates `sick`, both `pending_accountant`, so they continue
  to accounting exactly like a manager-entered request.

Auto-accept ("respected") rules against the week's entries:
- day_off / sick_expected: no entry of hers on date.
- partial: none of her entries on date overlaps [from, to).
- move_day: no entry on date and at least one on target_date.
- swap handover: none of hers on date, the colleague has one on date.
- swap mutual: as handover, plus she has one on target_date and the colleague none.
- other: never automatic.

## Employee side

- Sees her constraints with status; a rejection shows the reason.
- May cancel any non-final or accepted constraint. Cancelling after the week
  was published notifies the branch managers and tells her the rota is
  already built. An accepted constraint whose EmployeeRequest was already
  approved by accounting cannot be cancelled here ("פני למשרד"); a still
  pending one is rejected along with it.
- "בקשות אליי": a colleague's swap request (accept/decline) and broadcast
  offers ("אני יכולה"). Nobody but the manager sees who volunteered or in
  what order; the requester sees only "N עובדות הסכימו".

## Notifications

`constraint_decision` (employee: accepted/rejected + reason), `constraint_cancelled`
(managers), `swap_request` (colleague), `swap_response` (requester: colleague
accepted/declined), `swap_offer` (branch employees on broadcast), `swap_picked`
(requester + chosen volunteer).

## Out of scope

Phase 3 (cross-branch, payroll link for fixed-schedule staff, lateness report).
