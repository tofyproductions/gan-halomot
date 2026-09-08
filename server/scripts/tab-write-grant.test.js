#!/usr/bin/env node
/**
 * הרשאת פעולה למסך — `<tab>_write`.
 *
 * requireTabWrite used to mean "the tab AND one of these roles". That made
 * רישום חיצוני admin/accountant-only for anything but reading, and the two
 * people the office actually wanted uploading קליקטאק and תמ"ת files — a
 * מנהל מערכת לצפייה בלבד and one back-office employee — could not be given it
 * without being made admins.
 *
 * So the permission became a tab id of its own: `clicktac_write`, granted per
 * user or per role on the permissions screen exactly like a screen, read off
 * the same JWT with the same precedence. This proves the precedence, that the
 * grant stands in for the screen but never survives its removal, that the seven
 * ordinary roles are untouched, and that the pass is recorded on the request
 * (req.tabWriteGrant) so utils/branch-scope.js can open every branch to it.
 *
 *   node scripts/tab-write-grant.test.js
 */
const Module = require('module');

// Stub the proposal service so no model is touched: record the call, answer 202.
const proposals = [];
const realLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (request.endsWith('services/proposedChanges.service')) {
    return {
      propose: async (req, res) => {
        proposals.push({ method: req.method, url: req.originalUrl, role: req.user.role });
        res.status(202).json({ proposed: true, id: 'pc' });
      },
    };
  }
  return realLoad.call(this, request, parent, ...rest);
};

const { requireTabWrite, tabDecision } = require('../src/middleware/auth');
const viewerContext = require('../src/utils/viewerContext');

let failures = 0;
const ok = (cond, label, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${label}${cond || !detail ? '' : `  (${detail})`}`);
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

const mkReq = (method, url, user, extra = {}) => ({
  method, originalUrl: url, headers: { 'content-type': 'application/json' },
  body: {}, params: {}, query: {}, user, ...extra,
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

/** The real route gate: רישום חיצוני, acting. */
const gate = () => requireTabWrite('clicktac', 'system_admin', 'accountant');

const teacher = (over = {}) => ({ id: 't', full_name: 'מיכל גננת', role: 'teacher', ...over });

(async () => {
  console.log('\n🗝️  הרשאת פעולה למסך רישום חיצוני\n');

  console.log('קדימויות — tabDecision');
  eq(tabDecision({ tab_overrides_remove: ['clicktac_write'], tab_overrides_add: ['clicktac_write'] }, 'clicktac_write'),
    'deny', 'הסרה אישית גוברת על הוספה אישית');
  eq(tabDecision({ tab_overrides_add: ['clicktac_write'], role_tab_remove: ['clicktac_write'] }, 'clicktac_write'),
    'allow', 'הוספה אישית גוברת על הסרה לכל התפקיד');
  eq(tabDecision({ role_tab_remove: ['clicktac_write'], role_tab_add: ['clicktac_write'] }, 'clicktac_write'),
    'deny', 'הסרה לכל התפקיד גוברת על הוספה לכל התפקיד');
  eq(tabDecision({ role_tab_add: ['clicktac_write'] }, 'clicktac_write'), 'allow', 'הוספה לכל התפקיד — allow');
  eq(tabDecision({}, 'clicktac_write'), 'default', 'בלי חריגה בכלל — default');

  console.log('\nגננת שקיבלה את ההרשאה');
  {
    const req = mkReq('POST', '/api/tmt/import', teacher({ tab_overrides_add: ['clicktac', 'clicktac_write'] }));
    const r = await run(gate(), req);
    ok(r.nexted, 'גננת עם clicktac + clicktac_write כותבת → next');
    eq(r.req.tabWriteGrant, 'clicktac', 'ו-req.tabWriteGrant נושא את מזהה המסך');
  }
  {
    const req = mkReq('POST', '/api/tmt/import', teacher({ tab_overrides_add: ['clicktac'] }));
    const r = await run(gate(), req);
    ok(!r.nexted && r.res.statusCode === 403 && r.res.body?.code === 'READ_ONLY',
      'גננת עם clicktac בלבד → 403 READ_ONLY', `status=${r.res.statusCode} ${JSON.stringify(r.res.body)}`);
    eq(r.req.tabWriteGrant, undefined, 'ולא נרשמה הרשאת פעולה');
  }
  {
    const req = mkReq('POST', '/api/tmt/import', teacher({
      tab_overrides_add: ['clicktac_write'], tab_overrides_remove: ['clicktac'],
    }));
    const r = await run(gate(), req);
    ok(!r.nexted && r.res.statusCode === 403, 'הרשאת פעולה + הסרת המסך → 403 (אין מסך, אין פעולה)');
    eq(r.req.tabWriteGrant, undefined, 'ולא נרשמה הרשאת פעולה');
  }
  {
    // The grant on its own: acting implies seeing, so the screen is not a
    // second box the admin has to remember to tick.
    const req = mkReq('POST', '/api/tmt/import', teacher({ role_tab_add: ['clicktac_write'] }));
    const r = await run(gate(), req);
    ok(r.nexted, 'הרשאה לכל התפקיד (role_tab_add) → next');
    eq(r.req.tabWriteGrant, 'clicktac', 'עם req.tabWriteGrant');
  }
  {
    const req = mkReq('POST', '/api/external-enrollments/import', teacher({ role_tab_remove: ['clicktac_write'], tab_overrides_add: ['clicktac'] }));
    const r = await run(gate(), req);
    ok(!r.nexted && r.res.statusCode === 403, 'הסרה מפורשת של ההרשאה → 403');
  }

  console.log('\nהתפקידים שתמיד יכלו — ללא שינוי');
  for (const role of ['system_admin', 'accountant']) {
    const req = mkReq('POST', '/api/tmt/import', { id: 'a', role });
    const r = await run(gate(), req);
    ok(r.nexted, `${role} → next`);
    eq(r.req.tabWriteGrant, undefined, `${role} עובר בזכות התפקיד, בלי tabWriteGrant`);
  }
  for (const role of ['branch_manager', 'class_leader', 'teacher', 'assistant', 'cook']) {
    const req = mkReq('POST', '/api/tmt/import', { id: 'x', role, tab_overrides_add: ['clicktac'] });
    const r = await run(gate(), req);
    ok(!r.nexted && r.res.statusCode === 403, `${role} עם המסך בלבד → 403 (ללא שינוי)`);
  }
  {
    // An explicit DENY of the grant is authoritative, over any role — this is
    // what lets the office take uploads away from a system_admin/accountant
    // without touching the role or the screen. tabDecision(grantId) is
    // checked FIRST, so it beats the role list rather than the role list
    // beating it.
    const req = mkReq('POST', '/api/tmt/import', { id: 'a', role: 'system_admin', tab_overrides_remove: ['clicktac_write'] });
    const r = await run(gate(), req);
    ok(!r.nexted && r.res.statusCode === 403 && r.res.body?.code === 'READ_ONLY',
      'הסרה אישית של ההרשאה ממנהל מערכת → 403 READ_ONLY, גם שהתפקיד תמיד יכל',
      `status=${r.res.statusCode} ${JSON.stringify(r.res.body)}`);
  }
  {
    const req = mkReq('POST', '/api/tmt/import', { id: 'a', role: 'accountant', tab_overrides_remove: ['clicktac_write'] });
    const r = await run(gate(), req);
    ok(!r.nexted && r.res.statusCode === 403 && r.res.body?.code === 'READ_ONLY',
      'הסרה אישית של ההרשאה מהנהלת חשבונות → 403 READ_ONLY',
      `status=${r.res.statusCode} ${JSON.stringify(r.res.body)}`);
  }
  {
    const req = mkReq('POST', '/api/tmt/import', { id: 'a', role: 'system_admin', role_tab_remove: ['clicktac_write'] });
    const r = await run(gate(), req);
    ok(!r.nexted && r.res.statusCode === 403 && r.res.body?.code === 'READ_ONLY',
      'הסרה לכל התפקיד של מנהלי מערכת → 403 READ_ONLY, גם למנהל מערכת בודד',
      `status=${r.res.statusCode} ${JSON.stringify(r.res.body)}`);
  }
  {
    // No override on the grant at all — the default path, unchanged.
    const req = mkReq('POST', '/api/tmt/import', { id: 'a', role: 'accountant' });
    const r = await run(gate(), req);
    ok(r.nexted, 'הנהלת חשבונות בלי שום חריגה על ההרשאה → next (ברירת מחדל של התפקיד)');
    eq(r.req.tabWriteGrant, undefined, 'בלי tabWriteGrant — עברה בזכות התפקיד');
  }
  {
    const req = mkReq('POST', '/api/tmt/import', { id: 'a', role: 'system_admin', tab_overrides_remove: ['clicktac'] });
    const r = await run(gate(), req);
    ok(!r.nexted && r.res.statusCode === 403, 'הסרת המסך עצמו כן שוללת — גם ממנהל מערכת (ללא שינוי)');
  }

  console.log('\nהצופה');
  {
    // Under authMiddleware's manager fallback the role already says
    // branch_manager and viewerFallback is set — this is how the request really
    // arrives in production.
    const req = mkReq('POST', '/api/tmt/import', {
      id: 'v', role: 'branch_manager', actual_role: 'admin_viewer',
      managed_branch_ids: ['b1'], tab_overrides_add: ['clicktac_write'],
    }, { viewerFallback: true });
    let claims = [];
    const r = await new Promise((resolve) => {
      const res = fakeRes();
      let nexted = false;
      viewerContext.runViewerWrite(req, res, () => {
        gate()(req, res, () => {
          nexted = true;
          claims = viewerContext.get()?.claims || [];
        });
      });
      setImmediate(() => resolve({ nexted, res, req }));
    });
    ok(r.nexted, 'צופה תחת הגיבוי, עם ההרשאה → next');
    eq(r.req.tabWriteGrant, 'clicktac', 'עם req.tabWriteGrant');
    ok(claims.includes('requireTabWrite:grant:clicktac'),
      'והכתיבה נתבעה (claim) כדי שהשומר במסד לא יסרב לה', JSON.stringify(claims));
  }
  {
    const req = mkReq('POST', '/api/tmt/import', {
      id: 'v', role: 'branch_manager', actual_role: 'admin_viewer', managed_branch_ids: ['b1'],
    }, { viewerFallback: true });
    const r = await run(gate(), req);
    ok(!r.nexted && r.res.statusCode === 403,
      'אותה צופה בלי ההרשאה → 403 (שהעטיפה ב-authMiddleware הופכת ל-202/סירוב העלאה)');
  }
  {
    // A raw viewer — a router mounted without authMiddleware, or these tests.
    // The grant must not walk her straight into the database.
    proposals.length = 0;
    const req = mkReq('PUT', '/api/tmt/apply', {
      id: 'v', role: 'admin_viewer', managed_branch_ids: [], tab_overrides_add: ['clicktac_write'],
    });
    const r = await run(gate(), req);
    ok(!r.nexted && r.res.statusCode === 202 && r.res.body?.proposed === true,
      'צופה "גולמית" (בלי authMiddleware) עם ההרשאה → הצעה, לא כתיבה', `status=${r.res.statusCode}`);
    eq(proposals.length, 1, 'ונרשמה הצעה אחת');
  }
  {
    const req = mkReq('GET', '/api/tmt/imports', {
      id: 'v', role: 'admin_viewer', managed_branch_ids: [], tab_overrides_add: ['clicktac_write'],
    });
    const r = await run(gate(), req);
    ok(r.nexted, 'ואותה צופה קוראת כרגיל');
  }
  {
    const req = mkReq('POST', '/api/admin/users', {
      id: 'v', role: 'admin_viewer', managed_branch_ids: ['b1'], tab_overrides_add: ['clicktac_write'],
    });
    const r = await run(gate(), req);
    ok(!r.nexted && r.res.statusCode === 403, 'וההרשאה אינה מפתח ל-/api/admin');
  }

  console.log('\nללא משתמש');
  {
    const r = await run(gate(), { method: 'POST', originalUrl: '/api/tmt/import', headers: {} });
    ok(r.res.statusCode === 401, 'בלי משתמש → 401');
  }

  console.log(failures ? `\n❌ ${failures} כשלונות\n` : '\n✅ הכל עבר\n');
  process.exit(failures ? 1 : 0);
})();
