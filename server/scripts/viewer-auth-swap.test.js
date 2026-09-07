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
 * The three things that must stay true, and are asserted below:
 *   - a read anywhere else arrives as system_admin, with actual_role set;
 *   - /api/auth is excluded, so the CLIENT still learns the real role from
 *     /me and does not draw write buttons for somebody who may not press one;
 *   - /api/admin is excluded, so the existing gate still answers 403 rather
 *     than the viewer walking in as the admin.
 * A write is never swapped: it goes through viewerGate exactly as before.
 *
 *   node scripts/viewer-auth-swap.test.js
 */

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
  admin: { id: 'u-admin', full_name: 'אורי מנהל', role: 'system_admin' },
  teacher: { id: 'u-teacher', full_name: 'מיכל גננת', role: 'teacher', branch_id: 'b2' },
};
const tokenFor = (who) => jwt.sign(CLAIMS[who], env.JWT_SECRET, { expiresIn: '1h' });

/** Run a middleware over a signed request; resolve with { nexted, req, res }. */
function run(mw, { who, method = 'GET', url }) {
  return new Promise((resolve) => {
    const req = {
      method,
      originalUrl: url,
      headers: { authorization: `Bearer ${tokenFor(who)}`, 'content-type': 'application/json' },
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

  console.log('\nכתיבה — לעולם לא מוחלפת');
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const { req } = await run(authMiddleware, { who: 'viewer', method, url: '/api/payroll/manual-punches' });
    eq(req.user.role, 'admin_viewer', `${method} — התפקיד נשאר admin_viewer`);
    eq(req.user.actual_role, undefined, `${method} — לא נוסף actual_role`);
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
    const { req } = await run(optionalAuth, { who: 'viewer', method: 'POST', url: '/api/employees' });
    eq(req.user.role, 'admin_viewer', 'כתיבה — לא הוחלף');
  }
  {
    const { req } = await run(optionalAuth, { who: 'viewer', url: '/api/auth/me' });
    eq(req.user.role, 'admin_viewer', '/api/auth/me — לא הוחלף');
  }

  console.log(failures === 0 ? '\n✅ הכל עבר\n' : `\n❌ ${failures} בדיקות נכשלו\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
