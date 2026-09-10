# After the foundation: what stage 3 has to fix

Recorded 10.09.2026, on `feat/design-system` at the end of the theme + shell work,
against the demo server (`DEMO_CLICKTAC=1 npm --prefix server run demo:viewer`)
signed in as the `system_admin` demo user.

## What was checked

All 38 screens a `system_admin` reaches from the rail, walked in order, each one
waited on until the route actually changed before sampling.

| Check | Result |
|---|---|
| Every rail entry lands on its own screen | **38 of 38**, 38 distinct paths |
| Horizontal overflow at 1440px | **none**, on any screen |
| Horizontal overflow at 768px | **none** |
| Console errors on a fresh load | **none** |
| `design-tokens`, `nav-model`, `design-hex-budget` | pass |
| `tabs-constant-sync`, `viewer-role-exists`, `viewer-helpers`, `custom-roles` | pass (permission model undisturbed) |
| Branch manager reaches fingerprint enrolment | yes; billing link correctly hidden |
| Phone (375px): bottom bar, no overflow, logout reachable | yes |

Nothing is broken. Everything below is unfinished, which is a different thing.

## One decision worth knowing about

**The rail returns at 900px, not 768px.** That is MUI's `md`, and it was left
alone rather than pulled down to 768: a rail is 224px, and on a 768px tablet in
portrait that leaves 544px for a payroll table. The bottom bar plus the full
width is the better trade there, and every screen is still one tap away under
עוד. The spec says 768 in one line; 900 is what shipped and what is right.

## The work, ordered by how much the screen is used

Not ordered by how bad it looks. A small wrong thing on החתמות costs more than a
large one on a screen opened twice a year.

### 1. `רישום חיצוני` — `/external-enrollment`
The screen the whole redesign was argued from. Twelve stat tiles above the fold,
still in their own colours. Eight filter chips, each a different fill. The
verdict column carries a coloured `Chip` where a dot and a word would read
faster. Wants: `StatRow`, `Toolbar`, `StatusDot`, `Tag`, and the payment-method
colours turned into tokens rather than deleted — those ones carry meaning.

### 2. `שכר` — `/payroll`
`PayrollMonthTable.jsx` holds **148 colour literals**, the largest single
concentration in the client. Densest table in the app; the first real customer
for `DataTable` and its sticky header, numeric column type and RTL isolation.

### 3. `החתמות` — `/attendance`
`AttendanceMonitor.jsx`, **104 literals**. Used daily by branch managers, and
one of the four screens on the phone's bottom bar — so it needs the mobile card
layout, not just the colour work.

### 4. `עובדים` — `/employees`
`HoursReportDialog.jsx` carries 66 literals on its own. Dialog-heavy; a good
place to establish what a dialog looks like once.

### 5. `גבייה` — `/collections`
`CollectionsTable.jsx`, 36 literals.

### 6. `גאנט` — `/gantt`
`GanttEditor.jsx` 84 plus `ganttPrint.js` 55. Print output has its own rules and
should be looked at separately from the screen.

### 7. `utils/branchColors.js` — 116 literals, not a screen
Per-branch marker colours, used across payroll, the old header and the gantt.
These are semantic — a gan is identified by its colour in several places — so
they become a token group, not a deletion. Worth doing early because so much
depends on it.

### Then the rest
`מחירון` (29), `ביקורת תלושים` (27), and the long tail.

## Smaller things found on the way

- **`ספקים` (`/suppliers`) has no empty state.** With no suppliers it renders a
  title and an "הוסף ספק" button over blank space. `הזמנות` and `דף קשר`, by
  contrast, both say what is missing. Whatever `EmptyState` ends up looking like,
  this screen is the one to build it against.
- **Twelve screens are thin in the demo data** (`/leads`, `/archive`,
  `/employee-requests`, `/nursery`, `/supplies`, `/gifts`, `/classes`,
  `/events`, `/contacts`, `/orders`, `/stock`, `/suppliers`). That is the demo
  database being empty, not the screens being broken — but it also means their
  empty states are the only thing most of this audit could see of them, and they
  need a second pass against seeded data before anyone calls them done.

## The number to move

`docs/design/hex-budget.json` — **1130** hand-written colours today, across 73
files. `npm --prefix server run test:design-hex` prints the ten largest offenders
and fails if the number grows.
