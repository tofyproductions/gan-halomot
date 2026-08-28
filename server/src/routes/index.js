const router = require('express').Router();
const { authMiddleware } = require('../middleware/auth');

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

// Pi agent routes — authenticated with per-branch X-Agent-Secret header,
// NOT with the normal JWT flow used by the web client.
router.use('/agent', require('./agent.routes'));

// Protected routes that require auth for employees/salary
router.use('/employees', require('./employee.routes'));
router.use('/salary-requests', require('./salary.routes'));
// Payroll (TIMEDOX replacement) — CRUD for Employee model + attendance
router.use('/payroll', require('./payroll.routes'));
// Monthly payroll table — per-amuta breakdown + manual fields (sick, vacation, etc.)
router.use('/payroll-month', require('./payrollMonth.routes'));
// Employee requests (vacation, sick leave)
router.use('/employee-requests', require('./employeeRequests.routes'));
// Employee documents — files attached to an employee from the salary table
router.use('/employee-documents', require('./employeeDocuments.routes'));
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
router.use('/branches', require('./branch.routes'));
// The customer's own subscription — what they pay and why. Read-only.
router.use('/account', require('./account.routes'));
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
router.use('/classrooms', require('./classroom.routes'));
// לוח עדכונים יומי — the תינוקייה's day: meals, bottles, naps, what to bring
// tomorrow. Infant rooms only; the older rooms have no use for it.
router.use('/nursery', require('./nursery.routes'));
// The gan's photographs. Bytes in object storage, permission in the row —
// a staff photo belongs to the classroom, a parent's belongs to the family.
router.use('/photos', require('./photos.routes'));
// מבצעי מתנות — a round of gifts, the family's picks and the staff's final
// choice, ending in one file for the supplier.
router.use('/gifts', require('./gifts.routes'));
// עדכונים מהורים — what parents corrected about their own children. An
// acknowledgement queue, not an approval one: the changes are already live.
router.use('/parent-changes', require('./parentChanges.routes'));
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
router.use('/documents', require('./documents.routes'));
router.use('/supplies', require('./supplies.routes'));
router.use('/holidays', require('./holiday.routes'));
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
router.use('/employment-contracts', require('./employmentContracts.routes'));
router.use('/cibus-sync', require('./cibusSync.routes'));
router.use('/stock', require('./stock.routes'));

// Sync endpoint
const syncController = require('../controllers/sync.controller');
router.post('/sync', syncController.syncFromSheets);
router.post('/sync/check', syncController.syncCheck);

module.exports = router;
