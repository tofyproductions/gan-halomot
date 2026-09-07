#!/usr/bin/env node
/**
 * On a read, the viewer IS the admin — decided once, in authMiddleware.
 *
 * The design says a viewer "sees everything the admin sees": every list,
 * dashboard, payroll table and payslip, across all branches. That promise was
 * broken by 36 inline `role === 'system_admin'` tests spread over 17
 * controllers, each scoping its own query and quietly handing the viewer one
 * branch. Rather than sweep them — and lose the 37th one written next month —
 * authMiddleware swaps the role for the duration of a READ and keeps the true
 * role in `actual_role`.
 *
 * The three things that must stay true of the READ, and are asserted below:
 *   - a read anywhere else arrives as system_admin, with actual_role set;
 *   - /api/auth is excluded, so the CLIENT still learns the real role from
 *     /me and does not draw write buttons for somebody who may not press one;
 *   - /api/admin is excluded, so the existing gate still answers 403 rather
 *     than the viewer walking in as the admin.
 *
 * The WRITE is decided in the same place, for the same reason. It used to be
 * decided in requireRole/requireTab — and 77 staff write routes carry neither,
 * so on those the viewer simply wrote (PUT /api/branches/:id answered 200 and
 * filed nothing). Now every authenticated write passes decideViewerWrite once:
 * /api/auth is hers, /api/admin and /api/proposed-changes are refused, a
 * viewer holding branches continues as a branch_manager with the 403→202
 * wrapper installed, and anyone else's write is filed for approval on the spot.
 *
 *   node scripts/viewer-auth-swap.test.js
 */

/* The proposal service opens the models; record the call and answer 202. */
const Module = require('module');
const proposals = [];
const realLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (request.endsWith('services/proposedChanges.service')) {
    return {
      propose: async (req, res) => {
        proposals.push({ method: req.method, url: req.originalUrl, role: req.user.role });
        res.status(202).json({ proposed: true, id: 'pc', message: 'השינוי נשמר וממתין לאישור' });
      },
    };
  }
  return realLoad.call(this, request, parent, ...rest);
};

/* Nothing may read server/.env — stub dotenv before config/env loads it. */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};
process.env.JWT_SECRET = 'viewer-auth-swap-test-secret';

const jwt = require('jsonwebtoken');
const env = require('../src/config/env');
const { authMiddleware, optionalAuth, requireRole } = require('../src/middleware/auth');

let failures = 0;
const ok = (cond, label, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${label}${cond ? '' : `  (${extra})`}`);
  if (!cond) failures++;
};
const eq = (a, b, label) => ok(
  JSON.stringify(a) === JSON.stringify(b), label,
  `קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)}`,
);

function fakeRes() {
  const r = { statusCode: 200, body: null, headersSent: false };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; r.headersSent = true; return r; };
  return r;
}

const CLAIMS = {
  viewer: { id: 'u-viewer', full_name: 'אלעד צופה', role: 'admin_viewer', managed_branch_ids: ['b1'] },
  viewer0: { id: 'u-viewer0', full_name: 'ורד צופה', role: 'admin_viewer', managed_branch_ids: [] },
  admin: { id: 'u-admin', full_name: 'אורי מנהל', role: 'system_admin' },
  teacher: { id: 'u-teacher', full_name: 'מיכל גננת', role: 'teacher', branch_id: 'b2' },
  branch_manager: { id: 'u-bm', full_name: 'רותי מנהלת', role: 'branch_manager', managed_branch_ids: ['b1'] },
  accountant: { id: 'u-acc', full_name: 'חנה חשבת', role: 'accountant' },
  class_leader: { id: 'u-cl', full_name: 'שירה אחראית', role: 'class_leader', branch_id: 'b1' },
  assistant: { id: 'u-as', full_name: 'נועה סייעת', role: 'assistant', branch_id: 'b1' },
  cook: { id: 'u-ck', full_name: 'רינה מבשלת', role: 'cook', branch_id: 'b1' },
};
const tokenFor = (who) => jwt.sign(CLAIMS[who], env.JWT_SECRET, { expiresIn: '1h' });

/** Run a middleware over a signed request; resolve with { nexted, req, res }. */
function run(mw, { who, method = 'GET', url, contentType = 'application/json' }) {
  return new Promise((resolve) => {
    const req = {
      method,
      originalUrl: url,
      headers: { authorization: `Bearer ${tokenFor(who)}`, 'content-type': contentType },
      body: {}, params: {}, query: {},
    };
    const res = fakeRes();
    let nexted = false;
    Promise.resolve(mw(req, res, () => { nexted = true; }))
      .then(() => setImmediate(() => resolve({ nexted, req, res })));
  });
}

(async () => {
  console.log('\n🔁 החלפת התפקיד של הצופה בקריאה\n');

  console.log('קריאה רגילה — הצופה מגיעה כמנהלת מערכת');
  {
    const { nexted, req } = await run(authMiddleware, { who: 'viewer', url: '/api/employees?branch=all' });
    ok(nexted, 'הבקשה ממשיכה');
    eq(req.user.role, 'system_admin', 'GET /api/employees — התפקיד הוחלף ל-system_admin');
    eq(req.user.actual_role, 'admin_viewer', 'התפקיד האמיתי נשמר ב-actual_role');
  }
  {
    const { req } = await run(authMiddleware, { who: 'viewer', url: '/api/payroll-month?month=2026-09&branch=all' });
    eq(req.user.role, 'system_admin', 'GET /api/payroll-month — הוחלף גם כאן');
  }

  console.log('\n/api/auth — התפקיד האמיתי חייב להגיע ללקוח');
  {
    const { req } = await run(authMiddleware, { who: 'viewer', url: '/api/auth/me' });
    eq(req.user.role, 'admin_viewer', 'GET /api/auth/me — התפקיד נשאר admin_viewer');
    eq(req.user.actual_role, undefined, 'לא נוסף actual_role');
  }

  console.log('\n/api/admin — אין החלפה, והשער עדיין חוסם');
  {
    const { req } = await run(authMiddleware, { who: 'viewer', url: '/api/admin/users' });
    eq(req.user.role, 'admin_viewer', 'GET /api/admin/users — התפקיד נשאר admin_viewer');
    eq(req.user.actual_role, undefined, 'לא נוסף actual_role');

    // ...and the route gate that follows still refuses her.
    const res = fakeRes();
    let nexted = false;
    requireRole('system_admin')(req, res, () => { nexted = true; });
    ok(!nexted && res.statusCode === 403, 'requireRole(system_admin) מחזיר 403 אחרי ה-middleware');
  }
  {
    // Express folds case and repeated slashes; so must the exclusion.
    const { req } = await run(authMiddleware, { who: 'viewer', url: '/api//ADMIN/users' });
    eq(req.user.role, 'admin_viewer', '/api//ADMIN/users — עדיין ללא החלפה');
  }
  {
    // The client normalizes dot segments before the request goes on the wire.
    const { req } = await run(authMiddleware, { who: 'viewer', url: '/api/cibus-sync/%2e%2e/admin/users' });
    eq(req.user.role, 'admin_viewer', 'נתיב עם %2e%2e שמגיע ל-/api/admin — ללא החלפה');
  }

  console.log('\nכתיבה — מוכרעת כאן, בלי שהמסלול יבקש');
  {
    // The C1 case: /api/branches carries no requireRole and no requireTab, so
    // before this moved into authMiddleware the viewer's PUT reached the
    // controller and renamed the branch.
    proposals.length = 0;
    const { nexted, res } = await run(authMiddleware, { who: 'viewer0', method: 'PUT', url: '/api/branches/1' });
    ok(!nexted, 'PUT /api/branches/1 (ללא סניפים בניהול) — לא ממשיך למסלול');
    eq(res.statusCode, 202, 'ונענה 202');
    eq(res.body?.proposed, true, 'התשובה מסמנת proposed: true');
    eq(proposals.length, 1, 'נשמרה הצעה אחת');
    eq(proposals[0].url, '/api/branches/1', 'ההצעה נושאת את הנתיב');
  }
  {
    // A viewer WITH branches continues as a branch_manager, and whatever
    // answers 403 next — requireRole on an admin-only route, requireTabWrite,
    // or the controller's own scope check — becomes the proposal.
    proposals.length = 0;
    const { nexted, req, res } = await run(authMiddleware, { who: 'viewer', method: 'POST', url: '/api/suppliers' });
    ok(nexted, 'POST /api/suppliers (עם סניפים בניהול) — ממשיך למסלול');
    eq(req.user.role, 'branch_manager', 'ובתפקיד branch_manager לבקשה הזו בלבד');
    eq(req.viewerFallback, true, 'הבקשה מסומנת viewerFallback');
    eq(proposals.length, 0, 'עדיין לא נשמרה הצעה');

    res.status(403).json({ error: 'לא הסניף שלך' });
    await new Promise(r => setImmediate(r));
    eq(res.statusCode, 202, '403 מהבקר הפך ל-202');
    eq(res.body?.proposed, true, 'עם proposed: true');
    eq(proposals.length, 1, 'ואז נשמרה ההצעה');
    eq(req.user.role, 'admin_viewer', 'התפקיד חזר ל-admin_viewer לפני התשובה');
    eq(req.viewerFallback, undefined, 'וסימון ה-fallback הוסר');
  }
  {
    // A 200 under the fallback passes through untouched, and still undoes it.
    const { req, res } = await run(authMiddleware, { who: 'viewer', method: 'POST', url: '/api/suppliers' });
    res.json({ ok: true });
    eq(res.statusCode, 200, 'תשובה תקינה תחת ה-fallback עוברת כשהיא');
    eq(res.body, { ok: true }, 'והגוף לא נגע');
    eq(req.user.role, 'admin_viewer', 'והתפקיד חזר ל-admin_viewer');
  }
  {
    // Deciding a proposal is not a thing to propose.
    proposals.length = 0;
    const { nexted, res } = await run(authMiddleware, { who: 'viewer', method: 'POST', url: '/api/proposed-changes/1/decide' });
    ok(!nexted && res.statusCode === 403, 'POST /api/proposed-changes/1/decide — 403');
    eq(proposals.length, 0, 'ולא נוצרה הצעה');
  }
  {
    proposals.length = 0;
    const { nexted, res } = await run(authMiddleware, { who: 'viewer', method: 'PATCH', url: '/api/admin/users/1/role' });
    ok(!nexted && res.statusCode === 403, 'PATCH /api/admin/... — 403');
    eq(proposals.length, 0, 'ולא נוצרה הצעה');
  }
  {
    // A file cannot be queued for approval, so it is refused with a reason.
    proposals.length = 0;
    const { nexted, res } = await run(authMiddleware, {
      who: 'viewer0', method: 'POST', url: '/api/photos/upload',
      contentType: 'multipart/form-data; boundary=xyz',
    });
    ok(!nexted && res.statusCode === 403, 'העלאת קובץ ללא סניפים בניהול — 403');
    eq(res.body?.code, 'VIEWER_NO_UPLOAD', 'עם קוד VIEWER_NO_UPLOAD');
    eq(proposals.length, 0, 'ולא נוצרה הצעה');
  }
  {
    // Her own account. Proposing "let me log out" would be absurd.
    proposals.length = 0;
    const { nexted, req } = await run(authMiddleware, { who: 'viewer', method: 'POST', url: '/api/auth/logout' });
    ok(nexted, 'POST /api/auth/logout ממשיך כרגיל');
    eq(req.user.role, 'admin_viewer', 'והתפקיד נשאר admin_viewer');
    eq(proposals.length, 0, 'ולא נוצרה הצעה');
    const sp = await run(authMiddleware, { who: 'viewer', method: 'POST', url: '/api/auth/set-password' });
    ok(sp.nexted, 'POST /api/auth/set-password ממשיך כרגיל');
  }

  console.log('\nשבעת התפקידים האחרים — כתיבה ללא שינוי');
  for (const who of ['admin', 'branch_manager', 'accountant', 'class_leader', 'teacher', 'assistant', 'cook']) {
    proposals.length = 0;
    const { nexted, req } = await run(authMiddleware, { who, method: 'POST', url: '/api/branches' });
    ok(nexted && req.user.role === CLAIMS[who].role && proposals.length === 0,
      `${CLAIMS[who].role} — POST ממשיך, התפקיד כשהיה, ללא הצעה`);
  }

  console.log('\nתפקידים אחרים — ללא שינוי');
  {
    const { req } = await run(authMiddleware, { who: 'admin', url: '/api/employees' });
    eq(req.user.role, 'system_admin', 'מנהל מערכת — התפקיד כשהיה');
    eq(req.user.actual_role, undefined, 'מנהל מערכת — ללא actual_role');
  }
  {
    const { req } = await run(authMiddleware, { who: 'teacher', url: '/api/employees' });
    eq(req.user.role, 'teacher', 'גננת — התפקיד כשהיה');
    eq(req.user.actual_role, undefined, 'גננת — ללא actual_role');
  }

  console.log('\noptionalAuth — אותו כלל בדיוק');
  {
    const { req } = await run(optionalAuth, { who: 'viewer', url: '/api/employees' });
    eq(req.user.role, 'system_admin', 'קריאה — הוחלף');
    eq(req.user.actual_role, 'admin_viewer', 'התפקיד האמיתי נשמר');
  }
  {
    // Same decision, same place: a route open to anonymous callers is not a
    // route on which a viewer writes.
    proposals.length = 0;
    const { nexted, req } = await run(optionalAuth, { who: 'viewer', method: 'POST', url: '/api/employees' });
    ok(nexted, 'כתיבה — ממשיכה');
    eq(req.user.role, 'branch_manager', 'בתפקיד branch_manager (fallback)');
    const v0 = await run(optionalAuth, { who: 'viewer0', method: 'POST', url: '/api/employees' });
    ok(!v0.nexted && v0.res.statusCode === 202, 'צופה ללא סניפים — 202 והבקשה נעצרת');
    eq(proposals.length, 1, 'ונשמרה הצעה');
  }
  {
    const { req } = await run(optionalAuth, { who: 'viewer', url: '/api/auth/me' });
    eq(req.user.role, 'admin_viewer', '/api/auth/me — לא הוחלף');
  }

  console.log(failures === 0 ? '\n✅ הכל עבר\n' : `\n❌ ${failures} בדיקות נכשלו\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
