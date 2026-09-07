#!/usr/bin/env node
/**
 * A viewer's write that cannot be made becomes a card the approver can read,
 * and the viewer is told so — with 202, not 403, because nothing failed.
 *
 *   node scripts/proposed-change-propose.test.js
 */
const { propose } = require('../src/services/proposedChanges.service');

let failures = 0;
const ok = (cond, label) => { console.log(`  ${cond ? '✅' : '❌'} ${label}`); if (!cond) failures++; };
const eq = (a, b, label) => {
  const good = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  ${good ? '✅' : '❌'} ${label}${good ? '' : `  (קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)})`}`);
  if (!good) failures++;
};

function fakeRes() {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

(async () => {
  console.log('\n📨 שמירת שינוי לאישור\n');
  const created = [];
  const models = { ProposedChange: { create: async (doc) => { const d = { _id: 'pc1', ...doc }; created.push(d); return d; } } };

  const req = {
    method: 'PATCH',
    originalUrl: '/api/employees/e9?x=1',
    headers: { host: 'gan-halomot.onrender.com', 'content-type': 'application/json' },
    body: { full_name: 'דנה', hourly_rate: 45, branch_id: '64f1a2b3c4d5e6f7a8b9c0d1' },
    params: {}, query: { x: '1' },
    user: { id: 'u1', full_name: 'אלעד', role: 'admin_viewer' },
  };
  const res = fakeRes();
  const doc = await propose(req, res, { models });

  eq(res.statusCode, 202, 'עונה 202');
  eq(res.body.proposed, true, 'proposed: true');
  eq(res.body.id, 'pc1', 'מחזיר את המזהה');
  eq(res.body.approver, 'system_admin', 'עובדים → מנהל המערכת');
  ok(res.body.message.startsWith('השינוי נשמר וממתין לאישור'), 'ההודעה בעברית');

  eq(created.length, 1, 'מסמך אחד נשמר');
  eq(doc.method, 'PATCH', 'השיטה נשמרה');
  eq(doc.path, '/api/employees/e9?x=1', 'הנתיב כולל השאילתה');
  eq(doc.host, 'gan-halomot.onrender.com', 'המארח נשמר (לזיהוי הלקוח בהפעלה מחדש)');
  eq(doc.body, { full_name: 'דנה', hourly_rate: 45, branch_id: '64f1a2b3c4d5e6f7a8b9c0d1' }, 'הגוף נשמר כמו שהוא');
  eq(doc.requested_by, 'u1', 'מי ביקש');
  eq(doc.requested_by_name, 'אלעד', 'ובשמו');
  eq(doc.requested_role, 'admin_viewer', 'ובאיזה תפקיד');
  eq(doc.screen_label, 'עובדים', 'שם המסך');
  eq(doc.branch_id, '64f1a2b3c4d5e6f7a8b9c0d1', 'הסניף מהגוף');
  {
    const r2 = fakeRes();
    const d2 = await propose({ ...req, body: { branch_id: 'not-an-id' } }, r2, { models });
    eq(d2.branch_id, null, 'סניף שאינו מזהה תקין → null, לא קריסה');
  }
  {
    // The gate would have blocked this one, but if a path ever gets through,
    // the record must say what the wire would carry — not what was typed.
    const r3 = fakeRes();
    const d3 = await propose({ ...req, originalUrl: '/api/employees/../admin/users?x=1' }, r3, { models });
    eq(d3.path, '/api/admin/users?x=1', 'הנתיב נשמר מנורמל, כפי שהוא באמת יישלח');
  }
  eq(doc.approver, 'system_admin', 'המאשר');
  eq(doc.status, 'pending', 'ממתין');
  eq(doc.summary.map(r => r.label), ['שם מלא', 'שכר שעתי', 'סניף'], 'התקציר קריא');

  console.log(failures ? `\n❌ ${failures} כשלונות\n` : '\n✅ הכל עבר\n');
  process.exit(failures ? 1 : 0);
})();
