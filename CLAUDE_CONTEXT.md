---
name: timedox-replacement-project
description: Full attendance/payroll/kindergarten management system — current state, architecture, and open items as of 2026-04-16
type: project
originSessionId: 57698bfa-aa88-4b5a-b70f-807824f7f2d4
---
## Project: gan-halomot — Kindergarten Management System

**Live URL**: https://gan-halomot.onrender.com
**GitHub**: https://github.com/tofyproductions/gan-halomot.git
**DB**: MongoDB Atlas (MONGODB_URI set in Render dashboard env vars)

---

## ARCHITECTURE

```
gan-halomot/
├── server/          # Node.js + Express + Mongoose
│   ├── src/
│   │   ├── models/  # User, Branch, Classroom, Child, Registration, Collection,
│   │   │            # Employee, Punch, AgentCommand, Amuta, + others
│   │   ├── controllers/
│   │   │   ├── payroll.controller.js   # Employee CRUD, attendance, salary calc, clock-users, manual punches
│   │   │   ├── agent.controller.js     # Pi agent endpoints (punches, heartbeat, commands)
│   │   │   └── ...                     # children, collections, auth, branch, etc.
│   │   ├── services/payrollCalc.js     # Pure salary calculation engine
│   │   ├── middleware/agentAuth.js     # X-Agent-Secret per-branch timing-safe auth
│   │   └── routes/
│   │       ├── payroll.routes.js       # /api/payroll/* (employees, attendance, salary, clock-users, manual-punches)
│   │       ├── agent.routes.js         # /api/agent/:branchId/* (Pi→server)
│   │       └── ...
│   └── scripts/
│       ├── seed-attendance.js          # CSV → branches + amutot + 63 employees
│       ├── seed-clock-users.js         # Dump from clock → Branch.clock_users cache
│       ├── import-employees-xlsx.js    # 4 xlsx files → israeli_ids + fuzzy name matching
│       └── import-historical-punches.js # Device dump → Punch records with device timestamps
├── client/          # React + Vite + MUI v6 (RTL Hebrew)
│   └── src/
│       ├── components/
│       │   ├── payroll/
│       │   │   ├── SalaryTable.jsx           # Monthly salary table with OT columns
│       │   │   └── EmployeeDetailDialog.jsx  # Full employee view: summary, hours, loans, bonuses
│       │   ├── attendance/AttendanceMonitor.jsx  # Monthly punch grid (color-coded cells)
│       │   ├── employees/
│       │   │   ├── EmployeeManager.jsx       # Employee list with inline edit + clock matching
│       │   │   ├── HoursReportDialog.jsx     # Per-employee monthly hours + CSV export
│       │   │   └── ClockMatchDialog.jsx      # Match clock users to employees
│       │   ├── shared/ChildDetailDialog.jsx  # View/edit child + parent + payment info
│       │   ├── dashboard/Dashboard.jsx       # Classroom grid with colored cards
│       │   ├── collections/CollectionsTable.jsx  # Monthly billing table
│       │   └── layout/
│       │       ├── Header.jsx    # Grouped nav with MUI icons, draggable groups (localStorage)
│       │       └── Layout.jsx    # Branch-tinted background + floating clouds animation
│       ├── theme/rtlTheme.js     # MUI theme: colors, zebra tables, rounded components
│       └── utils/classroomColors.js  # בוגרים=dark blue, צעירים=light blue, תינוקייה=cyan
└── pi-agent/        # Runs on Raspberry Pi Zero 2 W per branch
    ├── agent.js     # 3 loops: punches (15s), commands (30s), heartbeat (60s)
    ├── lib/         # clock.js (node-zklib wrapper), server.js (HTTP+retry), state.js, logger.js
    ├── systemd/timedox-agent.service
    └── scripts/install.sh
```

---

## WHAT'S COMPLETE ✅ (as of 2026-04-16)

### TIMEDOX Replacement (Phase 1+2)
- **Pi agent** deployed on gan-pi-1 for Moshe Dayan branch, auto-starts on boot via systemd
- **Live punch flow**: Clock (10.0.0.3:4370) → Pi polling (15s) → HTTPS to Render → MongoDB Atlas
- **195 punches** in April 2026, all linked to employees
- **Dedup**: unique index on (branch_id, device_user_sn), safe re-upload
- **Auto-relink**: Employee post-save hook links orphan punches when israeli_id is set
- **Israeli ID normalization**: pre-save hook pads to 9 digits, incoming punches normalized too
- **Bootstrap**: `node agent.js --bootstrap` sets last_user_sn baseline, skips historical

### Employee/Payroll (Phase 3)
- **69 employees** across 4 branches, **65 with israeli_id** (imported from 4 xlsx files via fuzzy name matching)
- **4 active branches**: כפר סבא-קפלן, כפר סבא-משה דיין, תל אביב, הרצליה הרצוג
- **26 clock users** cached on Branch.clock_users for Moshe Dayan
- **Salary calculator**: hours→regular/OT125%/OT150% split, hourly×rate, global pro-rata when < required_hours, travel+meal+recreation+bonuses-loans
- **"Force full global"** toggle per employee per month in the detail dialog
- **Manual punches**: POST /api/payroll/manual-punches creates synthetic pair for forgotten punches
- **Delete punch**: DELETE /api/payroll/punches/:id
- **Historical import**: 163 April punches imported from device with correct timestamps (POC memory was WRONG about broken timestamps — they work fine)
- **March 2026 is empty** in the device (userSn continuous, no data loss — just no punches between Feb 27 and Apr 9)

### UI
- **Pages**: לוח בקרה, רישום, גבייה, ארכיון, דף קשר, גאנט, חופשות, הזמנות, ספקים, עובדים, החתמות, שכר
- **Navigation**: 3 grouped sections (ניהול, כוח אדם, תפעול) with MUI icons, draggable order saved in localStorage per user
- **Theme**: amber primary, zebra-striped tables, rounded cards/dialogs, consistent typography
- **Background**: floating clouds animation + branch-specific tint (pink/orange/cyan/yellow)
- **Classroom colors**: בוגרים=dark blue, צעירים=light blue, תינוקייה=cyan — applied in Dashboard classroom cards
- **Child detail dialog**: click child name in Dashboard or Collections → view parent/child/payment info → edit mode with month-specific fee change
- **Employee detail dialog**: click salary table row → 4 tabs (summary, daily hours, loans, bonuses)
- **Inline edit**: double-click on phone/travel in employee table → edit in place

---

## OPEN ITEMS / BUGS 🔴 (for next session)

### High Priority
1. **Collections per-child-per-month fee edit** — User needs to override the expected amount for a specific child for a specific month (e.g., a child got a different discount than the rest). Currently CollectionsTable only supports bulk discounts.
2. **Classroom colors in CollectionsTable rows** — Code is in place but needs testing. The header chips are colored, but child row backgrounds may not be tinted yet.
3. **fee_effective_from logic** — Registration model now has `fee_effective_from` and `previous_monthly_fee` fields, but the CollectionsTable calculation doesn't USE them yet. When the admin changes a child's monthly_fee with a start month, collections before that month should still show the old fee.
4. **render.yaml cleanup** — Still references Neon Postgres (`DATABASE_URL`) and `knex migrate:latest` in buildCommand. MONGODB_URI is set manually in Render dashboard. Works but should be cleaned up.

### Medium Priority
5. **Nav drag-and-drop** — Built with HTML5 DnD + localStorage. Not fully tested.
6. **Inline edit for salary/required_hours** — The EditableCell component exists but only phone and travel_allowance use it. Need to also support salary rate and required_hours (requires writing back to amuta_distribution).
7. **Amuta dropdown in employee edit** — When an employee has no amuta_distribution, the edit dialog can't set a rate. Need an amuta picker dropdown.
8. **3 more Pi's needed** — Branches 2-4 (שאול המלך/הרצוג/תל אביב) still need Pi Zero 2 W hardware + setup. ~240₪ total.
9. **Pro-rated global persistence** — The "force full global" toggle is session-only. Should persist per employee per month if the admin decides to pay full salary.

### Low Priority / Future
10. **Absence management** — sick days, vacation, reserve duty — not in the system yet
11. **Payroll finalization** — monthly approval workflow, export to accounting software
12. **Historical TIMEDOX import** — import data from TIMEDOX cloud for continuity
13. **Pi recovery script** — if state.json is lost, auto-recover last_user_sn from server DB
14. **The 17:00 rule** — user initially wanted "punches after 17:00 = always exit", later said "don't change". Leave pairing as-is (chronological).
15. **Write-to-clock** — node-zklib doesn't support setUser() for this firmware. Need raw protocol or different library.

---

## HARDWARE

### Branch 1 — Moshe Dayan (LIVE ✅)
- **Pi**: gan-pi-1, user: admin, SSH key auth from Amit's Mac
- **Pi IP**: 10.0.0.113 on Dream1_EXT WiFi (2.4GHz)
- **Clock**: TIMEDOX TANDEM4 PRO, IP 10.0.0.3, port 4370, 26 users, ~19,400 historical records
- **Agent**: systemd timedox-agent.service, code at /home/admin/timedox-agent/
- **Sudoers**: NOPASSWD for systemctl only

### Branches 2-4 — NOT SET UP
- כפר סבא שאול המלך, הרצליה הרצוג, תל אביב
- Need Pi Zero 2 W + microSD + power per branch
- Clock IPs need discovery
- Agent secrets already generated in DB

---

## KEY CREDENTIALS (references only, not stored here)
- MongoDB Atlas: in server/.env as MONGODB_URI
- Agent secrets: in Branch documents in MongoDB
- Pi SSH: key-based from Amit's Mac (~/.ssh/id_ed25519)
- Render: auto-deploys from GitHub main branch
- Auth: login with full_name + id_number (no password), JWT token 24h

---

## HOW TO RESUME IN A NEW SESSION

Tell Claude:
> "המשך פרויקט גן החלומות. קרא את memory/project_timedox_replacement.md — שם יש את כל הסטטוס. הנה מה שאני רוצה לעשות: [הבקשה שלך]"

The memory file has the full architecture, what's done, what's broken, and what's pending.
