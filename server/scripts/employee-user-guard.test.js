#!/usr/bin/env node
/**
 * The User CRUD endpoints (/api/employees) — two guards under test.
 *
 * 1. PRIVILEGE LADDER. update() let any same-branch manager set any same-
 *    branch User's password — including a system_admin's, because admins are
 *    filed under a branch too. That is "become the admin on next login".
 *    Now: password is admin-only, an admin/accountant target is untouchable
 *    by non-admins, and id_number/branch_id (identity + scope) are admin-only
 *    fields.
 *
 * 2. AUTH-STATE LEAK. getAll/getById returned everything minus password_hash
 *    — including otp_hash (a 6-digit code at bcrypt cost 10: offline minutes)
 *    and webauthn credentials. Now every response path strips auth state, and
 *    non-admins also lose salary/bank/ת"ז.
 *
 * The User model is stubbed via Module._load (the viewer tests' pattern), so
 * this runs without a database.
 *
 *   node scripts/employee-user-guard.test.js
 */
const Module = require('module');

// ── stub the models module as seen by employee.controller ──────────────────
let dbUser = null; // the doc findById returns
const realLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (request === '../models' && parent && parent.filename.endsWith('controllers/employee.controller.js')) {
    return {
      User: {
        findById: async () => dbUser,
        find: () => { throw new Error('not under test'); },
        findOne: async () => null,
        create: async (doc) => makeDoc(doc),
      },
    };
  }
  return realLoad.call(this, request, parent, ...rest);
};

function makeDoc(fields) {
  return {
    ...fields,
    saved: false,
    async save() { this.saved = true; },
    toObject() {
      const { save, toObject, ...rest } = this;
      return { ...rest };
    },
  };
}

const controller = require('../src/controllers/employee.controller');

let failures = 0;
const ok = (cond, label) => {
  console.log(`  ${cond ? '✅' : '❌'} ${label}`);
  if (!cond) failures++;
};

// Minimal express doubles.
function run(fn, { user, params = {}, body = {} }) {
  return new Promise((resolve) => {
    const res = {
      code: 200,
      status(c) { this.code = c; return this; },
      json(payload) { resolve({ code: this.code, payload }); },
    };
    fn({ user, params, body }, res, (err) => resolve({ code: 500, err }));
  });
}

(async () => {
  console.log('\n🪜 the privilege ladder\n');

  const B1 = 'b1';
  const manager = { role: 'branch_manager', branch_id: B1 };
  const admin = { role: 'system_admin', branch_id: null };

  // Same-branch manager + employee target + password → refused, nothing saved.
  dbUser = makeDoc({ _id: 'u1', role: 'employee', branch_id: B1, full_name: 'א' });
  let r = await run(controller.update, { user: manager, params: { id: 'u1' }, body: { password: 'x' } });
  ok(r.code === 403, 'מנהל סניף מנסה לשנות סיסמה → 403');
  ok(dbUser.saved === false, '…ושום דבר לא נשמר');

  // Same-branch manager + ADMIN target → refused outright, any field.
  dbUser = makeDoc({ _id: 'u2', role: 'system_admin', branch_id: B1, full_name: 'ב' });
  r = await run(controller.update, { user: manager, params: { id: 'u2' }, body: { full_name: 'ג' } });
  ok(r.code === 403, 'מנהל סניף עורך רשומת אדמין → 403');
  ok(dbUser.saved === false, '…ושום דבר לא נשמר');

  // Same-branch manager + employee target: id_number/branch_id ignored, phone applied.
  dbUser = makeDoc({ _id: 'u3', role: 'employee', branch_id: B1, id_number: '111', phone: '' });
  r = await run(controller.update, {
    user: manager, params: { id: 'u3' },
    body: { id_number: '999', branch_id: 'b9', phone: '050' },
  });
  ok(r.code === 200 && dbUser.saved === true, 'עריכה לגיטימית של מנהל — עוברת');
  ok(dbUser.id_number === '111', 'ת"ז לא השתנתה (שדה אדמין)');
  ok(dbUser.branch_id === B1, 'סניף לא השתנה (שדה אדמין)');
  ok(dbUser.phone === '050', 'טלפון כן השתנה');

  // Admin sets a password → allowed, hash lands.
  dbUser = makeDoc({ _id: 'u4', role: 'employee', branch_id: B1 });
  r = await run(controller.update, { user: admin, params: { id: 'u4' }, body: { password: 'secret1' } });
  ok(r.code === 200 && typeof dbUser.password_hash === 'string' && dbUser.password_hash.startsWith('$2'),
    'אדמין משנה סיסמה — נשמר bcrypt');

  console.log('\n🕳️ the auth-state leak\n');

  // update() echoes the saved doc — auth state must be scrubbed from it.
  dbUser = makeDoc({
    _id: 'u5', role: 'employee', branch_id: B1,
    otp_hash: 'LEAK', otp_expires_at: 'LEAK', webauthn_credentials: ['LEAK'],
    webauthn_challenge: 'LEAK', board_token: 'LEAK', password_hash: 'LEAK',
    full_name: 'ד',
  });
  r = await run(controller.update, { user: admin, params: { id: 'u5' }, body: { phone: '1' } });
  const echoed = r.payload.employee;
  ok(echoed.otp_hash === undefined, 'otp_hash לא חוזר בתשובה');
  ok(echoed.webauthn_credentials === undefined, 'webauthn_credentials לא חוזר');
  ok(echoed.board_token === undefined, 'board_token לא חוזר');
  ok(echoed.password_hash === undefined, 'password_hash לא חוזר');
  ok(echoed.full_name === 'ד', 'שדות רגילים כן חוזרים');

  // getAll/getById route their projection through userSelectFor — assert the
  // select strings by reading the source (the queries are stubbed here).
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../src/controllers/employee.controller.js'), 'utf8');
  ok((src.match(/\.select\(userSelectFor\(req\.user\.role\)\)/g) || []).length >= 2,
    'getAll וגם getById בוחרים שדות לפי תפקיד');
  ok(src.includes('-otp_hash') && src.includes('-webauthn_credentials') && src.includes('-board_token'),
    'הפרויקציה מדירה את כל שדות מצב-האימות');
  ok(src.includes('-salary') && src.includes('-id_number'),
    'לא-אדמין מאבד גם שכר/בנק/ת"ז');

  console.log('');
  if (failures) { console.log(`❌ ${failures} נכשלו`); process.exit(1); }
  console.log('✅ הכל עבר');
})();
