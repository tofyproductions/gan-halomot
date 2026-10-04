# סידור עבודה — שלב 3: סניפים אחרים, שכר ודוח נוכחות (design)

Builds on phases 1–2 (live on main e8bd8db). Decisions from the grill-me
session (memory `gan-shifts-planning`) plus four answered on 2026-10-04.

## A. Employee from another branch

1. **Eligibility.** A manager may place an employee of another branch only if
   that employee has a rate for the host branch: an `Employee.branch_rates`
   row for the host with `hourly_rate > 0` (or `global_salary > 0`).
   Otherwise the save is refused and the screen offers a **rate request**.
2. **Rate request** (`BranchRateRequest`): host manager proposes an hourly
   rate (optional) → **home branch manager** approves/rejects (reason
   required) → **office** (system_admin or accountant, either) approves with
   the final rate (defaults to the proposal, required > 0) or rejects. On
   final approval the rate is written to `Employee.branch_rates` for the host
   branch (update `hourly_rate` if a row exists, else add one). The employee is
   not asked. Each step notifies the next decider; the requester is told the
   outcome.
3. **Every placement needs home approval.** An entry of a foreign employee is
   `cross_branch: true` with `cross_status`:
   - `approved` when the same placement (employee, date, start, end) was
     already approved in the stored week, or an **active permanent
     arrangement** covers it (same host branch, weekday, start, end);
   - otherwise `pending`, and the home branch managers are notified.
   The home manager approves or rejects each pending placement from her own
   board (reject needs a reason; a rejected entry is removed from the host
   week and the host managers are told why).
4. **Publish is refused** while the week has a `pending` cross-branch entry.
5. **No double booking across branches.** Saving a week refuses an entry of
   employee X that overlaps any entry of X in another branch's week for the
   same dates (draft entries count). Different hours on the same day are fine
   (e.g. 07:00–13:00 home, 13:00–17:00 host).
6. **Home manager sees her people elsewhere.** Her board shows, read-only, a
   row "בסניפים אחרים" with her employees' entries in other branches' weeks
   (with pending/approved), and a panel of placements waiting for her.
7. **Permanent arrangement** (`CrossBranchArrangement`): when the home manager
   approves a placement and the host branch's two previous weeks also had an
   approved entry for the same employee, weekday, start and end, the system
   proposes a permanent arrangement. It becomes `active` only when **both**
   managers confirm; either may cancel an active (or proposed) one alone.
   While active, matching placements are auto-approved.

## B. Fixed-schedule employees follow the published rota

For employees with `fixed_schedule.enabled` (two people today): when a week
is **published**, each date of that week becomes a rota exception on the
employee's fixed schedule — her rota hours for the day (earliest start →
latest end, at the branch of that entry) or `off` when she has no entry on an
open day. Manual exceptions (set by a person) are never overwritten. Already
generated punches for those dates (past days only exist) are removed so the
next materialisation regenerates them from the rota; the generated punches
carry the rota branch so cross-branch rates apply. Unpublished weeks change
nothing — the fixed hours apply as today.

## C. Daily attendance-vs-rota report

Every morning at 07:00 (Israel), about **yesterday** (Sunday–Friday): for each
branch whose week is published, every employee who was placed yesterday and
is not a fixed-schedule employee:
- no punch at all that day → "לא הגיעה";
- first punch more than 30 minutes after her earliest scheduled start →
  "איחור N דקות".
Push to the branch's managers (their branch only) and to the office (network
summary); informational only, nothing to approve. A report screen (dialog on
the rota board, `?report=YYYY-MM-DD`) lists the rows.

## Permissions

Unchanged from phases 1–2: placing/approving is the branch manager of the
relevant branch; office approves rates and views; employees unaffected.
