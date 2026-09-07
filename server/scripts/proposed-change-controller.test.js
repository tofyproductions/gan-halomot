#!/usr/bin/env node
/**
 * The proposals endpoint: who sees what, and what deciding does.
 *
 * The models index opens mongoose, and the service would send a real request,
 * so both are stubbed at require time (same technique as
 * scripts/viewer-branch-scope.test.js). What is under test is the controller's
 * own logic: the viewer's narrowed view, the atomic claim that stops a double
 * replay, and the outcome written after the replay answers.
 *
 *   node scripts/proposed-change-controller.test.js
 */
const Module = require('module');

// ---------- the fake database ----------
let rows = [];
let users = {};

function matches(row, filter) {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === '$or') return cond.some(sub => matches(row, sub));
    const value = row[key];
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if (Array.isArray(cond.$in)) return cond.$in.includes(value);
      if (cond.$lt !== undefined) return value != null && value < cond.$lt;
    }
    return value === cond;
  });
}

const ProposedChange = {
  find(filter = {}) {
    const hit = () => rows.filter(r => matches(r, filter)).map(r => ({ ...r }));
    return { sort: () => ({ limit: () => ({ lean: async () => hit() }) }) };
  },
  async countDocuments(filter = {}) {
    return rows.filter(r => matches(r, filter)).length;
  },
  async findOneAndUpdate(filter, update, opts = {}) {
    const row = rows.find(r => matches(r, filter));
    if (!row) return null;
    Object.assign(row, update.$set || {});
    return opts.new ? { ...row } : { ...row };
  },
  async updateOne(filter, update) {
    const row = rows.find(r => matches(r, filter));
    if (row) Object.assign(row, update.$set || {});
    return { modifiedCount: row ? 1 : 0 };
  },
};

const User = {
  findById: (id) => ({ select: () => ({ lean: async () => users[id] || null }) }),
};

// ---------- the fake replay ----------
let applyCalls = [];
let applyResult = { status: 200, ok: true, error: '' };

const realLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  const from = parent && parent.filename ? parent.filename : '';
  if (from.endsWith('controllers/proposedChanges.controller.js')) {
    if (request === '../models') return { ProposedChange, User };
    if (request === '../services/proposedChanges.service') {
      return {
        applyProposal: async (doc, approver, opts) => {
          applyCalls.push({ id: String(doc._id), path: doc.path, approver, opts });
          return applyResult;
        },
      };
    }
  }
  return realLoad.call(this, request, parent, ...rest);
};

const c = require('../src/controllers/proposedChanges.controller');

// ---------- harness ----------
let failures = 0;
const eq = (a, b, label) => {
  const good = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  ${good ? '✅' : '❌'} ${label}${good ? '' : `  (קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)})`}`);
  if (!good) failures++;
};

function fakeRes() {
  const r = { statusCode: 200, body: null };
  r.status = (s) => { r.statusCode = s; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
const boom = (err) => { throw err; };

const admin = { id: 'sa1', role: 'system_admin', full_name: 'מנהלת' };
const viewer = { id: 'v1', role: 'admin_viewer', full_name: 'צופה' };

function seed() {
  rows = [
    { _id: 'p1', status: 'pending', requested_by: 'v1', method: 'PATCH', path: '/api/employees/e1', host: 'h', body: {} },
    { _id: 'p2', status: 'pending', requested_by: 'v2', method: 'POST', path: '/api/children', host: 'h', body: {} },
    { _id: 'p3', status: 'applying', requested_by: 'v1', method: 'POST', path: '/api/gifts', host: 'h', body: {}, decided_at: new Date() },
    { _id: 'p4', status: 'failed', requested_by: 'v1', method: 'POST', path: '/api/orders', host: 'h', body: {} },
    { _id: 'p5', status: 'approved', requested_by: 'v2', method: 'POST', path: '/api/stock', host: 'h', body: {} },
  ];
  users = { sa1: { _id: 'sa1', email: 'sa@x', full_name: 'מנהלת', role: 'system_admin', branch_id: null, managed_branch_ids: [] } };
  applyCalls = [];
  applyResult = { status: 200, ok: true, error: '' };
}

(async () => {
  console.log('\n🗂️ מסך ההצעות\n');

  console.log('רשימה');
  {
    seed();
    const res = fakeRes();
    await c.list({ user: viewer, query: {} }, res, boom);
    eq(res.body.items.map(i => i._id), ['p1', 'p3', 'p4'], 'צופה רואה רק את ההצעות שלה');
    eq(res.body.pending_count, 0, 'ולא את המונה הארגוני');
  }
  {
    seed();
    const res = fakeRes();
    await c.list({ user: admin, query: {} }, res, boom);
    eq(res.body.items.map(i => i._id), ['p1', 'p2', 'p3', 'p4', 'p5'], 'המשרד רואה הכול');
    eq(res.body.pending_count, 2, 'ומונה את הממתינות');
  }
  {
    seed();
    const res = fakeRes();
    await c.list({ user: admin, query: { status: 'pending' } }, res, boom);
    eq(res.body.items.map(i => i._id), ['p1', 'p2', 'p3'], 'סינון "ממתין" כולל גם הצעה שבאמצע הפעלה');
  }
  {
    seed();
    const res = fakeRes();
    await c.list({ user: admin, query: { status: 'failed' } }, res, boom);
    eq(res.body.items.map(i => i._id), ['p4'], 'סינון אחר — כפי שהוא');
  }

  console.log('\nמונה');
  {
    seed();
    const res = fakeRes();
    await c.count({ user: admin }, res, boom);
    eq(res.body.pending_count, 2, 'למשרד — כל הממתינות');
  }
  {
    seed();
    const res = fakeRes();
    await c.count({ user: viewer }, res, boom);
    eq(res.body.pending_count, 1, 'לצופה — רק שלה');
  }

  console.log('\nהכרעה');
  {
    seed();
    const res = fakeRes();
    await c.decide({ user: admin, params: { id: 'p1' }, body: { decision: 'maybe' } }, res, boom);
    eq([res.statusCode, res.body.error], [400, 'decision חייב להיות approve או reject'], 'החלטה שאינה approve/reject → 400');
    eq(applyCalls.length, 0, 'ולא הופעל כלום');
  }
  {
    seed();
    const res = fakeRes();
    await c.decide({ user: admin, params: { id: 'p5' }, body: { decision: 'approve' } }, res, boom);
    eq([res.statusCode, res.body.error], [409, 'ההצעה כבר הוכרעה'], 'הצעה שכבר הוכרעה → 409');
    eq(applyCalls.length, 0, 'ולא הופעלה שוב');
  }
  {
    seed();
    const res = fakeRes();
    await c.decide({ user: admin, params: { id: 'p1' }, body: { decision: 'approve', note: 'בסדר' } }, res, boom);
    eq(applyCalls.map(a => a.id), ['p1'], 'אישור מפעיל את ההצעה פעם אחת');
    eq(res.body.proposal.status, 'approved', 'והיא מסומנת מאושרת');
    eq([res.body.proposal.apply_status, res.body.proposal.apply_error], [200, ''], 'עם תשובת השרת');
    eq([rows[0].status, rows[0].decided_by, rows[0].decision_note], ['approved', 'sa1', 'בסדר'], 'וכך גם נשמר');
  }
  {
    // The claim is the whole point: a second approve must find nothing.
    seed();
    const a = fakeRes(); const b = fakeRes();
    const req = () => ({ user: admin, params: { id: 'p1' }, body: { decision: 'approve' } });
    await Promise.all([c.decide(req(), a, boom), c.decide(req(), b, boom)]);
    eq(applyCalls.length, 1, 'שני אישורים במקביל — הפעלה אחת בלבד');
    eq([a.statusCode, b.statusCode].sort().join(','), '200,409', 'אחד הצליח, השני קיבל 409');
  }
  {
    seed();
    applyResult = { status: 409, ok: false, error: 'החודש נעול' };
    const res = fakeRes();
    await c.decide({ user: admin, params: { id: 'p1' }, body: { decision: 'approve' } }, res, boom);
    eq(res.body.proposal.status, 'failed', 'הפעלה שנכשלה → failed');
    eq([res.body.proposal.apply_status, res.body.proposal.apply_error], [409, 'החודש נעול'], 'עם הודעת השרת');
    eq(rows[0].status, 'failed', 'ונשמר');
  }
  {
    seed();
    const res = fakeRes();
    await c.decide({ user: admin, params: { id: 'p1' }, body: { decision: 'reject', note: 'לא' } }, res, boom);
    eq(res.body.proposal.status, 'rejected', 'דחייה → rejected');
    eq(applyCalls.length, 0, 'בלי להפעיל כלום');
    eq([rows[0].status, rows[0].decision_note], ['rejected', 'לא'], 'ונשמר');
  }
  {
    seed();
    users = {};   // the approver's user row is gone
    const res = fakeRes();
    await c.decide({ user: admin, params: { id: 'p1' }, body: { decision: 'approve' } }, res, boom);
    eq(res.body.proposal.status, 'failed', 'אין מאשר → failed, לא קריסה');
    eq(res.body.proposal.apply_error, 'המאשר לא נמצא', 'עם הסיבה');
    eq([rows[0].status, applyCalls.length], ['failed', 0], 'נשמר, ולא נשלחה בקשה');
  }

  console.log('\nניסיון חוזר');
  {
    seed();
    const res = fakeRes();
    await c.retry({ user: admin, params: { id: 'p5' } }, res, boom);
    eq([res.statusCode, res.body.error], [409, 'אפשר לנסות שוב רק הצעה שנכשלה'], 'הצעה מאושרת → 409');
    eq(applyCalls.length, 0, 'בלי הפעלה');
  }
  {
    seed();
    const res = fakeRes();
    await c.retry({ user: admin, params: { id: 'p4' } }, res, boom);
    eq(applyCalls.map(a => a.id), ['p4'], 'הצעה שנכשלה — מופעלת שוב');
    eq([res.body.proposal.status, rows[3].status], ['approved', 'approved'], 'והפעם הצליחה');
  }
  {
    seed();
    const res = fakeRes();
    await c.retry({ user: admin, params: { id: 'p3' } }, res, boom);
    eq([res.statusCode, applyCalls.length], [409, 0], 'הצעה שבאמצע הפעלה — לא נוגעים בה');
  }
  {
    seed();
    rows[2].decided_at = new Date(Date.now() - 5 * 60 * 1000);   // a replay that died
    const res = fakeRes();
    await c.retry({ user: admin, params: { id: 'p3' } }, res, boom);
    eq(applyCalls.map(a => a.id), ['p3'], 'הפעלה תקועה מעל שתי דקות — נשחררת לניסיון חוזר');
    eq(rows[2].status, 'approved', 'ונסגרת');
  }

  console.log(failures ? `\n❌ ${failures} כשלונות\n` : '\n✅ הכל עבר\n');
  process.exit(failures ? 1 : 0);
})();
