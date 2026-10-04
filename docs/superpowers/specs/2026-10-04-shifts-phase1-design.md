# סידור עבודה שבועי — שלב 1 (design)

Source: grill-me session with עמית, 2026-10-04. Phase 1 of 3. Phases 2
(אילוצים) and 3 (cross-branch + payroll link + lateness report) are NOT in
scope here, but the data model below must not block them.

## Problem

Branch managers build the weekly staff rota outside the system (paper,
WhatsApp images). The system already knows each employee's weekly commitment
(`EmployeeCommitment`), the classes, the enrolled children and the gan's
closure days — none of it helps build the rota today.

## Scope (phase 1)

1. **Weekly board per branch**, Sunday–Friday. Rows = the branch's active
   classes, plus three fixed rows: `מטבח`, `מחליפות`, `ללא כיתה`
   (the last one only appears while it holds someone). Columns = days.
   Each cell holds entries: employee name + `HH:MM–HH:MM`.
2. **Opening a week** ("פתיחת סידור") seeds entries from `EmployeeCommitment`:
   - one entry per non-off commitment day, hours from the commitment;
   - row = the employee's `primary_classroom_id` if set and active; else
     `מטבח` / `מחליפות` when the commitment's free-text `classroom` says so;
     else `ללא כיתה`;
   - closure days (Holiday `kind:'closure'` for the branch, plus the week's
     manual closed days) get no entries;
   - the commitment's alternating day (`is_alternating_off` +
     `alternating_day`) is seeded as a working entry marked `alternating`;
     the manager decides per week whether it is off (one tap removes it).
3. **Editing**: add / move / change hours / delete an entry. An employee may
   have several entries on one day (mid-day class switch). Entries of the
   same employee on the same day must not overlap — the save is refused with
   a message naming the employee and day.
4. **New class for an employee**: an entry in a class that is neither her
   primary nor in `extra_classroom_ids` is flagged on the board (`new_class`)
   and, on save, the class is added to her `extra_classroom_ids`
   permanently, no approval.
5. **Primary class prompt**: when the board loads, active employees of the
   branch who have a commitment, no `primary_classroom_id`, and whose
   commitment is not kitchen/floater are listed in a dialog. Each has a
   suggestion derived from the commitment's free text (exact class name, or
   the only active class of that category) and the candidate classes. The
   manager confirms or changes; the choice is saved to the employee card.
6. **Closed days**: Holiday closures are greyed and not droppable. The
   manager may close an extra day for this week with one click (confirm:
   removes that day's entries) and reopen it.
7. **Close / reopen a class** from the board: sets `Classroom.is_active`.
   Closing is refused while the class has active enrolled children. Reopen
   lists the branch's inactive classes of the current academic year. Only
   reopening — children are assigned on the children screen as today.
8. **Staff ratio warnings** (managers + management only, never employees or
   parents, never blocking): per day per class with a category,
   `needed = ceil(enrolled / ratio)`; warn when distinct employees placed in
   that class that day `< needed`. `enrolled` = active children whose
   `classroom_id` is the class. Defaults by branch name: starts with
   `כפר סבא` → infants 5, young 7, older 9; otherwise infants 5, young 8,
   older 10. Per-branch override stored on `Branch.staff_ratios`, editable
   from the board's settings dialog by the branch manager or admin.
9. **Publish ("סגירת סידור")**: copies the working entries to the published
   snapshot. First publish notifies every employee on the rota ("הסידור
   לשבוע … פורסם"). Later edits stay unpublished until the next close; on
   that close only employees whose own entries changed get "הסידור שלך
   עודכן". Employees always see the published snapshot, never a draft.
10. **Reminder**: Friday from 12:00 (Israel), if next week's rota of an active
    branch is not published, its branch managers get one push.
11. **Export**: one-click PDF (print window, `@page` A4 landscape) and PNG
    (html2canvas) of the published-or-current table: header = branch name +
    dates; row per class/area; column per day; cell = names + hours. Colour
    mark for an entry that is part of a mid-day class switch. Ratio
    warnings and flags are NOT printed. More than 8 rows → split into pages
    of 8 rows.
12. **Employee screen "המשמרות שלי"**: the whole published rota of her
    branch for the current and next week, her own entries highlighted.
13. **Permissions**:
    - branch manager: full edit for branches she manages
      (`managed_branch_ids`, fallback `branch_id`);
    - system_admin / accountant: view all branches; an edit is submitted as a
      request ("בקשת שינוי") that the branch manager approves or rejects
      (reject needs a reason); approval applies it to the working entries;
    - admin_viewer: view only;
    - employees (`teacher`, `assistant`, `class_leader`, `cook`): only
      "המשמרות שלי".

## Out of scope (phases 2–3)

Constraints, swaps, cross-branch employees and rates, payroll effect for
fixed-schedule employees, lateness/no-show report. Phase 1 has NO effect on
punches or pay.

## Data model

`ShiftWeek` (one per branch per week):

```
branch_id        ObjectId ref Branch, required
week_start       'YYYY-MM-DD' (a Sunday), required
entries          [Entry]   — the working copy the manager edits
published        [Entry]   — snapshot at last close ([] = never published)
published_at     Date|null
published_by     ObjectId ref User|null
closed_days      ['YYYY-MM-DD']  — manual closures for this week only
created_by       ObjectId ref User
unique index {branch_id, week_start}
```

`Entry`: `{ _id, employee_id, employee_name, date, area: 'class'|'kitchen'|'floater'|'unassigned', classroom_id|null, start_hhmm, end_hhmm, alternating:Boolean, new_class:Boolean }`

`ShiftEditRequest`: `{ shift_week_id, branch_id, entries:[Entry], status: 'pending'|'approved'|'rejected', requested_by, requested_by_name, decided_by, decided_by_name, decided_at, reject_reason }`

`Branch.staff_ratios`: `{ infants:Number|null, young:Number|null, older:Number|null }` (null = city default).

## Notification types (NotificationEvent enum)

`shift_published`, `shift_changed`, `shift_close_reminder`,
`shift_edit_request`, `shift_edit_decision`.
