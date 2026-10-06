const router = require('express').Router();
const { authMiddleware, attachBranchScope, requireRole } = require('../middleware/auth');

// GanFlow control plane — the customer registry, and the only place that knows
// other customers exist. Mounted only when PLATFORM_MONGODB_URI is configured,
// so a server without it (גן החלומות, today) does not gain a single route.
if (require('../platform/connection').isEnabled()) {
  router.use('/platform', require('../platform/routes'));

  // Everything BELOW this line belongs to one customer, and runs holding that
  // customer's models. Mounted under the control plane on purpose: the console
  // is ours and is reached without a customer in the address.
  //
  // `required: true` is the load-bearing word. Without it a request that names
  // no customer falls through to the default connection — which on a control
  // plane is an empty database on a good day and somebody else's gan on a bad
  // one. It refuses instead.
  const { tenantResolver } = require('../platform/resolve');
  const { runWith } = require('../platform/context');
  router.use(tenantResolver({ required: true }));
  router.use((req, res, next) => runWith(req.models, next));
}

// Public routes (no auth required)
router.use('/auth', require('./auth.routes'));
router.use('/public', require('./public.routes'));
router.use('/utils', require('./utils.routes'));

// Which version of the mobile apps is live in the stores, and where to get it.
// Anonymous on purpose: the app asks this BEFORE anybody signs in, and a
// version number is not a secret. Written only by a system_admin, under /admin.
router.get('/app-version', require('../controllers/appVersion.controller').publicVersions);

// Pi agent routes — authenticated with per-branch X-Agent-Secret header,
// NOT with the normal JWT flow used by the web client.
router.use('/agent', require('./agent.routes'));

// Bank feed from the bank-pi agent — HMAC-signed, not a user session.
router.use('/finance/agent', require('./financeAgent.routes'));

// המוח's read window — its own Bearer key (BRAIN_READ_KEY), GET only, closed
// (503) while the key is unset. See routes/brain.routes.js.
router.use('/brain', require('./brain.routes'));

// Task-board sync — same idea as the agent above: its own shared-key + HMAC
// scheme rather than the JWT flow, so it sits with the routes that authenticate
// themselves. Read-only, and closed entirely when TASKS_SYNC_KEY is unset.
router.use('/sync', require('./sync.routes'));

// The import bot — a robot that signs in to Cibus and ClickTac, downloads the
// reports neither of them exposes an API for, and posts the files here. Its own
// shared key, write-only, two routes, and closed entirely when
// IMPORT_BOT_SECRET is unset. See the file for why it is not an account.
router.use('/import-bot', require('./importBot.routes'));

// Protected routes that require auth for employees/salary
router.use('/employees', require('./employee.routes'));
router.use('/salary-requests', require('./salary.routes'));
// Payroll (TIMEDOX replacement) — CRUD for Employee model + attendance
router.use('/payroll', require('./payroll.routes'));
// Monthly payroll table — per-amuta breakdown + manual fields (sick, vacation, etc.)
router.use('/payroll-month', require('./payrollMonth.routes'));
// Punch follow-up — the employee fixes her own missing/duplicate/empty days first.
router.use('/punch-followup', require('./punchFollowup.routes'));
// What accounting decided on the requests THIS person sent — one answer across
// the three separate request collections a branch manager writes into.
router.use('/my-decisions', require('./decisions.routes'));
router.use('/contact-requests', require('./contactRequests.routes'));
// Employee requests (vacation, sick leave)
router.use('/employee-requests', require('./employeeRequests.routes'));
// Employee documents — files attached to an employee from the salary table
router.use('/employee-documents', require('./employeeDocuments.routes'));
router.use('/employee-roster-import', require('./employeeRosterImport.routes'));
// לוחות כיתה — the tablet accounts on the classroom walls.
router.use('/classroom-boards', require('./classroomBoard.routes'));
// רישומי עובדים — what a new hire filled in about themselves, waiting for
// somebody to turn it into an employee card.
router.use('/employee-onboarding', require('./employeeOnboarding.routes'));
// תיק העובד — every file the system holds about one person, read out of the
// six stores that already hold them (contracts, uploads, certificates, sick
// notes, issued letters, payslips + hours reports).
router.use('/employee-file', require('./employeeFile.routes'));
// טופס 101 — the roster view, the mail scan and its review queue
router.use('/form-101', require('./form101.routes'));
// Class tracking (מעקב חוגים) — providers, programs, sessions + occurrence popup
router.use('/classes', require('./classes.routes'));
// Maintenance (אחזקה) — assets per branch with service cycles + fault reports
router.use('/maintenance', require('./maintenance.routes'));
// Gan events (אירועים) — manager builds a bring-list, parents claim items via a
// public link. Manager side here; the parent-facing side lives under /public.
router.use('/gan-events', require('./ganEvents.routes'));
// Leads (פניות הורים) — manager side; the public inquiry form lives under /public.
router.use('/leads', require('./leads.routes'));

// Parent portal. Its own accounts, its own signing key, its own guard — a
// parent's token cannot satisfy the staff middleware below and a staff token
// cannot satisfy this one. Mounted here, above that middleware, deliberately.
router.use('/parent', require('./parent.routes'));

// Everything below requires a logged-in user.
//
// This was `optionalAuth` — "backward compatible, works without login too" —
// which in practice meant the whole application was readable AND writable by
// anyone with the URL: an unauthenticated GET /api/collections returned every
// child's name, their parent's name and the family's fees. The only genuinely
// anonymous surfaces are /api/public (parent + employee token links),
// /api/auth, /api/utils and /api/agent (Pi agents, own shared-secret header),
// and all four are mounted ABOVE this line.
router.use(authMiddleware);
// The branch boundary, resolved once per request from the DB and hung on req.
// Every branch-scoped query below reads it (utils/branch-filter). Must sit
// directly after authMiddleware so req.user exists and nothing scoped runs
// before it.
router.use(attachBranchScope);
// The bank screen (user JWT). The agent's signed door is mounted above, before auth.
router.use('/finance', require('./finance.routes'));
router.use('/expenses', require('./expenses.routes'));
router.use('/income', require('./income.routes'));
router.use('/branches', require('./branch.routes'));
// The customer's own subscription — what they pay and why. Read-only.
router.use('/account', require('./account.routes'));
router.use('/push', require('./push.routes'));
// The notifications waiting for the caller — the second place to look when a
// push arrived while the phone was in a drawer. See the controller.
router.use('/notifications', require('./notifications.routes'));
router.use('/data-deletion', require('./dataDeletion.routes'));
router.use('/dashboard', require('./dashboard.routes'));
router.use('/children', require('./children.routes'));
router.use('/registrations', require('./registration.routes'));
// קליקטאק — enrollments from the מעונות אמונה system, reviewed before they
// become registrations here.
router.use('/external-enrollments', require('./externalEnrollment.routes'));
// משרד התמ"ת — the ministry's approval list, and the reconciliation against
// ClickTac that decides who is actually enrolled next year.
router.use('/tmt', require('./tmtApproval.routes'));
router.use('/contracts', require('./contracts.routes'));
router.use('/collections', require('./collections.routes'));
router.use('/archives', require('./archive.routes'));
router.use('/contacts', require('./contacts.routes'));
// הכתובות המותאמות של מסך קישורים להפצה.
router.use('/share-links', require('./shareLinks.routes'));
router.use('/classrooms', require('./classroom.routes'));
// לוח עדכונים יומי — the תינוקייה's day: meals, bottles, naps, what to bring
// tomorrow. Infant rooms only; the older rooms have no use for it.
router.use('/nursery', require('./nursery.routes'));
// The gan's photographs. Bytes in object storage, permission in the row —
// a staff photo belongs to the classroom, a parent's belongs to the family.
router.use('/photos', require('./photos.routes'));
// The teachers' "who is this?" queue. Separate from /photos because it is a
// different job done at a different moment — thirty photographs come off a
// phone in the garden, and naming the faces in them happens sitting down.
router.use('/face-tagging', require('./faceTagging.routes'));
// מבצעי מתנות — a round of gifts, the family's picks and the staff's final
// choice, ending in one file for the supplier.
router.use('/gifts', require('./gifts.routes'));
// עדכונים מהורים — what parents corrected about their own children. An
// acknowledgement queue, not an approval one: the changes are already live.
router.use('/parent-changes', require('./parentChanges.routes'));
// מעקב הורים רשומים — who reached the portal and who the office must chase.
router.use('/parent-signups', require('./parentSignups.routes'));
// הודעות לגן — what the gan tells the families. A teacher writes, a branch
// manager publishes; the portal is free, WhatsApp is a copy on her clipboard,
// and SMS is capped per branch per month because one prepaid balance also
// sends every parent's sign-in code.
router.use('/announcements', require('./announcements.routes'));
// היעדרויות — what the families said in advance. Read-only: the parent reports
// from the portal and the staff record attendance on the nursery board.
router.use('/absences', require('./absences.routes'));
// מורשי איסוף — who may collect a child. The parent proposes and the gan
// grants; revoking needs nobody's permission.
router.use('/pickup', require('./pickup.routes'));
// גיוס עובדים — candidates from the website form, routed to the branch they
// asked for. BELOW authMiddleware, deliberately: the controller decides what a
// caller may see from req.user, so without one it computes an empty scope and
// silently returns nothing — which is what it did while this sat above the
// line, and it left /recruitment/pull reachable by anyone with the URL.
router.use('/recruitment', require('./recruitment.routes'));
// אישורי מעון — the papers a branch operates under, with their expiry dates.
router.use('/branch-certifications', require('./branchCertifications.routes'));
// קורסים והכשרות — every עובדת's מד"א and התנהלות בטוחה, and when they run out.
router.use('/employee-courses', require('./employeeCourses.routes'));
// פערי רישום — the roster each branch actually keeps, against the cards here.
router.use('/roster-gap', require('./rosterGap.routes'));
router.use('/documents', require('./documents.routes'));
router.use('/supplies', require('./supplies.routes'));
router.use('/holidays', require('./holiday.routes'));
router.use('/parent-supply-list', require('./supplyList.routes'));
router.use('/activities', require('./activity.routes'));
router.use('/gantt', require('./gantt.routes'));
// בנק תוכן — the ideas a week is built from, indexed by its subject. Feeds the
// gantt editor; ships with the system and is added to per gan.
router.use('/content-bank', require('./contentBank.routes'));
router.use('/suppliers', require('./supplier.routes'));
router.use('/products', require('./product.routes'));
router.use('/orders', require('./order.routes'));
router.use('/discounts', require('./discount.routes'));
router.use('/branch-pricing', require('./branchPricing.routes'));
router.use('/admin', require('./admin.routes'));
router.use('/employee-letters', require('./employeeLetters.routes'));
// מסמכים להורים — אישור שהות בגן ואישור קייטנה, מופקים מהמערכת.
router.use('/parent-letters', require('./parentLetters.routes'));
// העלאות שכר קבועות — המנהלת קובעת, הנה"ח מיישמת דרך תנאי ההעסקה המתוארכים.
router.use('/rate-changes', require('./rateChangeRequests.routes'));
// סידור עבודה — the weekly rota a branch manager builds and publishes.
router.use('/shifts', require('./shifts.routes'));
// שינויים לאישור — writes a viewer ("מנהל מערכת - לצפייה בלבד") asked for.
router.use('/proposed-changes', require('./proposedChanges.routes'));
router.use('/employment-contracts', require('./employmentContracts.routes'));
router.use('/cibus-sync', require('./cibusSync.routes'));
router.use('/stock', require('./stock.routes'));

// Sync endpoint
const syncController = require('../controllers/sync.controller');
// Writes registrations/children/collections from the office spreadsheet —
// an import trigger, not a read; not for every login to press.
router.post('/sync', requireRole('system_admin', 'accountant'), syncController.syncFromSheets);
router.post('/sync/check', syncController.syncCheck);

module.exports = router;
