#!/usr/bin/env node
/**
 * The one gate every route passes through, and what it does with a viewer.
 *
 * Reads: wherever a system admin may read, except /api/admin.
 * Writes: as a branch manager when the route allows managers and the viewer
 * has branches; queued for approval otherwise; refused for uploads and for
 * /api/admin. A controller that answers 403 under the manager fallback (the
 * target was outside the viewer's branches) is turned into a proposal.
 * Every other role: exactly as before.
 *
 *   node scripts/viewer-require-role.test.js
 */
const Module = require('module');

// Stub the proposal service so no model is touched: record the call, answer 202.
const proposals = [];
const realLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (request.endsWith('services/proposedChanges.service')) {
    return {
      propose: async (req, res) => {
        proposals.push({ method: req.method, url: req.originalUrl, role: req.user.role, body: req.body });
        res.status(202).json({ proposed: true, id: 'pc', message: 'השינוי נשמר וממתין לאישור מנהל המערכת' });
      },
    };
  }
  return realLoad.call(this, request, parent, ...rest);
};

const { requireRole, requireBranchScope } = require('../src/middleware/auth');

let failures = 0;
const ok = (cond, label) => { console.log(`  ${cond ? '✅' : '❌'} ${label}`); if (!cond) failures++; };
const eq = (a, b, label) => {
  const good = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  ${good ? '✅' : '❌'} ${label}${good ? '' : `  (קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)})`}`);
  if (!good) failures++;
};

function fakeRes() {
  const r = { statusCode: 200, body: null, headersSent: false };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; r.headersSent = true; return r; };
  return r;
}
const viewer = (managed = []) => ({ id: 'u', full_name: 'אלעד', role: 'admin_viewer', managed_branch_ids: managed });
const mkReq = (method, url, user, extra = {}) => ({
  method, originalUrl: url, headers: { 'content-type': 'application/json' }, body: {}, params: {}, query: {}, user, ...extra,
});

/** Run the gate; resolve with {nexted, res, req}. */
function run(gate, req) {
  return new Promise((resolve) => {
    const res = fakeRes();
    let nexted = false;
    const maybe = gate(req, res, () => { nexted = true; });
    Promise.resolve(maybe).then(() => setImmediate(() => resolve({ nexted, res, req })));
  });
}

(async () => {
  console.log('\n🚪 שער התפקידים והצופה\n');

  console.log('קריאות');
  {
    const r = await run(requireRole('system_admin', 'accountant'), mkReq('GET', '/api/payroll-month?month=2026-09', viewer()));
    ok(r.nexted, 'צופה קורא היכן שמנהל מערכת קורא');
  }
  {
    const r = await run(requireRole('branch_manager'), mkReq('GET', '/api/something', viewer(['b1'])));
    ok(!r.nexted && r.res.statusCode === 403, 'מסלול שמנהל מערכת אינו ברשימתו — הכלל הרגיל (403)');
  }
  {
    const r = await run(requireRole('system_admin'), mkReq('GET', '/api/admin/users', viewer()));
    ok(!r.nexted && r.res.statusCode === 403, '/api/admin חסום גם לקריאה');
  }

  console.log('\nכתיבות');
  proposals.length = 0;
  {
    const r = await run(requireRole('system_admin', 'accountant'), mkReq('PUT', '/api/payroll-month/special-days/1', viewer(['b1']), { body: { name: 'יום' } }));
    ok(!r.nexted && r.res.statusCode === 202 && r.res.body.proposed === true, 'כתיבה במסלול של המשרד → נשמר לאישור (202)');
    eq(proposals.length, 1, 'הצעה אחת נרשמה');
    eq(proposals[0].role, 'admin_viewer', 'ההצעה נרשמה בתפקיד הצופה');
  }
  {
    const r = await run(requireRole('system_admin', 'accountant', 'branch_manager'), mkReq('POST', '/api/payroll-month/punch-resolutions', viewer(['b1'])));
    ok(r.nexted && r.req.user.role === 'branch_manager' && r.req.viewerFallback === true, 'מסלול שמותר למנהל סניף + יש סניפים → ממשיך כמנהל סניף');
  }
  {
    const r = await run(requireRole('system_admin', 'accountant', 'branch_manager'), mkReq('POST', '/api/payroll-month/punch-resolutions', viewer([])));
    ok(!r.nexted && r.res.statusCode === 202, 'אותו מסלול בלי סניפים → נשמר לאישור');
  }
  {
    const r = await run(requireRole('system_admin'), mkReq('PATCH', '/api/admin/users/1/role', viewer(['b1'])));
    ok(!r.nexted && r.res.statusCode === 403, 'כתיבה תחת /api/admin → 403, בלי הצעה');
  }
  {
    const req = mkReq('POST', '/api/documents', viewer([]), { headers: { 'content-type': 'multipart/form-data; boundary=x' } });
    const r = await run(requireRole('system_admin', 'accountant'), req);
    ok(!r.nexted && r.res.statusCode === 403 && r.res.body.code === 'VIEWER_NO_UPLOAD', 'העלאת קובץ → 403 עם קוד, לא הצעה');
  }

  console.log('\n403 מהבקר תחת הגיבוי כמנהל סניף');
  proposals.length = 0;
  {
    const r = await run(requireRole('system_admin', 'accountant', 'branch_manager'), mkReq('PATCH', '/api/employees/e1', viewer(['b1']), { body: { full_name: 'x' } }));
    ok(r.nexted, 'השער העביר הלאה');
    // The controller now says "not your branch":
    r.res.status(403).json({ error: 'ניתן לערוך רק עובדי הסניפים שבניהולך' });
    await new Promise(res => setImmediate(res));
    eq(r.res.statusCode, 202, 'ה-403 הפך ל-202');
    eq(r.res.body.proposed, true, 'והתשובה היא הצעה');
    eq(proposals.length, 1, 'ההצעה נרשמה');
    eq(r.req.user.role, 'admin_viewer', 'התפקיד שוחזר לצופה לפני הרישום');
  }
  {
    const r = await run(requireRole('system_admin', 'accountant', 'branch_manager'), mkReq('PATCH', '/api/employees/e1', viewer(['b1'])));
    r.res.status(400).json({ error: 'חסר שדה' });
    eq(r.res.statusCode, 400, '400 מהבקר עובר כמו שהוא');
  }
  {
    const r = await run(requireRole('system_admin', 'accountant', 'branch_manager'), mkReq('PATCH', '/api/employees/e1', viewer(['b1'])));
    r.res.status(200).json({ ok: true });
    eq(r.res.body, { ok: true }, '200 מהבקר עובר כמו שהוא');
  }
  {
    const req = mkReq('POST', '/api/photos', viewer(['b1']), { headers: { 'content-type': 'multipart/form-data; boundary=x' } });
    const r = await run(requireRole('system_admin', 'branch_manager'), req);
    ok(r.nexted, 'העלאה במסלול של מנהלי סניף ממשיכה (הבקר יבדוק את הסניף)');
    r.res.status(403).json({ error: 'לא הסניף שלך' });
    await new Promise(res => setImmediate(res));
    ok(r.res.statusCode === 403 && r.res.body.code === 'VIEWER_NO_UPLOAD', 'ו-403 על העלאה נשאר סירוב, לא הצעה');
  }

  console.log('\nשבעת התפקידים הקיימים — ללא שינוי');
  for (const role of ['system_admin', 'branch_manager', 'accountant', 'class_leader', 'teacher', 'assistant', 'cook']) {
    const allowed = await run(requireRole(role), mkReq('POST', '/api/x', { role }));
    const denied = await run(requireRole('nobody'), mkReq('POST', '/api/x', { role }));
    ok(allowed.nexted && !denied.nexted && denied.res.statusCode === 403 && allowed.req.viewerFallback === undefined, role);
  }
  {
    const r = await run(requireRole('system_admin'), { method: 'GET', originalUrl: '/api/x', headers: {} });
    ok(r.res.statusCode === 401, 'בלי משתמש → 401');
  }

  console.log('\nrequireBranchScope');
  {
    const r = await run(requireBranchScope, mkReq('GET', '/api/payroll-month/my-updates', viewer([])));
    ok(r.nexted, 'צופה עובר, גם בלי סניפים');
  }

  console.log(failures ? `\n❌ ${failures} כשלונות\n` : '\n✅ הכל עבר\n');
  process.exit(failures ? 1 : 0);
})();
