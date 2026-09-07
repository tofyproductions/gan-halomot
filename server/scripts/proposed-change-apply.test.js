#!/usr/bin/env node
/**
 * Approving a proposal re-issues the stored request as the approver, at the
 * same address and host it came to. The replay's answer is the proposal's
 * fate: 2xx applied, anything else failed-with-reason.
 *
 *   node scripts/proposed-change-apply.test.js
 */
const jwt = require('jsonwebtoken');
const env = require('../src/config/env');
const { applyProposal, mintApproverToken } = require('../src/services/proposedChanges.service');

let failures = 0;
const ok = (cond, label) => { console.log(`  ${cond ? '✅' : '❌'} ${label}`); if (!cond) failures++; };
const eq = (a, b, label) => {
  const good = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  ${good ? '✅' : '❌'} ${label}${good ? '' : `  (קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)})`}`);
  if (!good) failures++;
};

(async () => {
  console.log('\n🔁 הפעלת שינוי מאושר\n');

  const approver = { id: 'acc1', email: 'a@x', full_name: 'רו"ח', role: 'accountant', branch_id: null, managed_branch_ids: [] };
  const doc = {
    _id: 'pc1', method: 'PATCH', path: '/api/employees/e9?x=1', host: 'gan-halomot.onrender.com',
    body: { full_name: 'דנה' }, content_type: 'application/json',
  };

  console.log('הטוקן');
  {
    const token = mintApproverToken(approver, 'demo');
    const payload = jwt.verify(token, env.JWT_SECRET);
    eq(payload.role, 'accountant', 'בתפקיד המאשר');
    eq(payload.id, 'acc1', 'ובזהותו');
    eq(payload.replay, true, 'מסומן כהפעלה חוזרת');
    eq(payload.tenant, 'demo', 'עם הלקוח');
    ok(payload.exp - payload.iat === 300, 'תוקף 5 דקות');
  }

  console.log('\nהבקשה שנשלחת');
  {
    const calls = [];
    const transport = async (url, init) => { calls.push({ url, init }); return { status: 200, text: async () => '{"ok":true}' }; };
    const r = await applyProposal(doc, approver, { transport, baseUrl: 'http://127.0.0.1:3001', tenantSlug: 'demo' });
    eq(r, { status: 200, ok: true, error: '' }, '2xx → הצליח');
    eq(calls[0].url, 'http://127.0.0.1:3001/api/employees/e9?x=1', 'לאותו נתיב, כולל השאילתה, מול השרת עצמו');
    eq(calls[0].init.method, 'PATCH', 'באותה שיטה');
    eq(calls[0].init.headers.Host, 'gan-halomot.onrender.com', 'עם המארח המקורי');
    eq(calls[0].init.headers['Content-Type'], 'application/json', 'JSON');
    eq(calls[0].init.headers['X-Proposed-Change'], 'pc1', 'מסומן במזהה ההצעה');
    ok(calls[0].init.headers.Authorization.startsWith('Bearer '), 'עם טוקן');
    eq(jwt.verify(calls[0].init.headers.Authorization.slice(7), env.JWT_SECRET).role, 'accountant', 'של המאשר');
    eq(calls[0].init.body, JSON.stringify({ full_name: 'דנה' }), 'והגוף השמור');
  }
  {
    const transport = async () => ({ status: 200, text: async () => '' });
    const r = await applyProposal({ ...doc, method: 'DELETE', body: null }, approver, { transport, baseUrl: 'http://127.0.0.1:1' });
    eq(r.ok, true, 'מחיקה בלי גוף — עובר');
  }

  console.log('\nנתיב שנשמר אינו מסמכות לשלוח');
  {
    const bad = ['נתיב לא חוקי להפעלה חוזרת'];
    const check = async (path, label) => {
      const calls = [];
      const transport = async (url, init) => { calls.push({ url, init }); return { status: 200, text: async () => '' }; };
      const r = await applyProposal({ ...doc, path }, approver, { transport, baseUrl: 'http://127.0.0.1:3001' });
      eq([r.status, r.ok, r.error], [0, false, bad[0]], label);
      eq(calls.length, 0, `  ${label} — לא נשלח בכלל`);
    };
    // The gate saw "/api/cibus-sync/..."; the wire would carry "/api/admin/...".
    await check('/api/cibus-sync/%2e%2e/admin/users/1/role', 'יציאה מקודדת אל /api/admin נדחית');
    await check('/api/x/../admin/users', 'יציאה עם .. אל /api/admin נדחית');
    await check('@evil.com/x', 'נתיב בלי / מוביל נדחה (חטיפת מארח)');
    await check('//evil.com/api/employees', 'כתובת מוחלטת לשרת אחר נדחית');
    await check('/api/proposed-changes/pc2/decide', 'אישור עצמי של הצעה נדחה');
    await check('/health', 'מחוץ ל-/api נדחה');
    // Express folds case and repeated slashes; a row that says one of these
    // lands in admin.routes with the approver's system_admin token.
    await check('/api//admin/users/1/role', 'לוכסן כפול אל /api/admin נדחה');
    await check('/api/ADMIN/users/1/role', 'אותיות גדולות אל /api/admin נדחות');
    await check('/api/PROPOSED-CHANGES/p1/decide', 'הכרעה באותיות גדולות נדחית');
  }
  {
    const calls = [];
    const transport = async (url, init) => { calls.push({ url, init }); return { status: 200, text: async () => '' }; };
    const r = await applyProposal(doc, approver, { transport, baseUrl: 'http://127.0.0.1:3001' });
    eq([r.ok, calls.length, calls[0]?.url], [true, 1, 'http://127.0.0.1:3001/api/employees/e9?x=1'], 'נתיב רגיל — נשלח כרגיל');
  }

  console.log('\nכישלונות');
  {
    const transport = async () => ({ status: 409, text: async () => '{"error":"החודש נעול"}' });
    const r = await applyProposal(doc, approver, { transport, baseUrl: 'http://127.0.0.1:1' });
    eq(r, { status: 409, ok: false, error: 'החודש נעול' }, 'תשובה שאינה 2xx → נכשל, עם הודעת השרת');
  }
  {
    const transport = async () => ({ status: 500, text: async () => 'not json' });
    const r = await applyProposal(doc, approver, { transport, baseUrl: 'http://127.0.0.1:1' });
    eq(r, { status: 500, ok: false, error: 'not json' }, 'גוף שאינו JSON — הטקסט עצמו');
  }
  {
    const transport = async () => { throw new Error('ECONNREFUSED'); };
    const r = await applyProposal(doc, approver, { transport, baseUrl: 'http://127.0.0.1:1' });
    eq(r, { status: 0, ok: false, error: 'ECONNREFUSED' }, 'אין חיבור → 0 עם השגיאה');
  }

  console.log(failures ? `\n❌ ${failures} כשלונות\n` : '\n✅ הכל עבר\n');
  process.exit(failures ? 1 : 0);
})();
