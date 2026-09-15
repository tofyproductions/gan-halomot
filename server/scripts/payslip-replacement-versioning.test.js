#!/usr/bin/env node
/**
 * A replacement payslip must not destroy the one it replaces.
 *
 * The business rule, in the words it was given in: an approved cycle is a
 * closed cycle, but a single correction for a single person may still be filed
 * after their payslip was approved AND sent — and that person must be able to
 * see that their payslip was replaced.
 *
 * What the code did instead: `deliverPayslipToEmployee` upserted SavedPayslip
 * on (employee, month) and overwrote `data` in place. The bytes the employee
 * had already received were gone — not superseded, GONE. There was no version,
 * no history, and nothing anywhere said a replacement had happened. A payroll
 * record silently losing the document that was sent is the one outcome this
 * system cannot have.
 *
 * Pinned here, in the order the month actually happens:
 *
 *   1. First send — version 1, nothing marked, no history.
 *   2. Re-send of the SAME bytes — not a replacement. No history row, no mark.
 *      (A distribution re-run must not tell 68 employees their payslip changed.)
 *   3. Corrected payslip — old bytes archived intact, version 2, replaced_at
 *      set, and both the employee's endpoint and the managers' screen say so.
 *   4. A second correction — version 3, BOTH earlier versions still readable.
 *   5. A manager-copy archive landing on a delivered row keeps the old bytes
 *      too, but must NOT claim to the employee that her payslip was replaced —
 *      she never received the manager's bundle.
 *
 * The email provider is stubbed, so nothing leaves the machine. The database is
 * ephemeral and local, and the URI is asserted loopback before the first write.
 *
 *   node scripts/payslip-replacement-versioning.test.js
 */

const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};

const mailed = [];
const emailPath = require.resolve('../src/services/email.service');
require.cache[emailPath] = {
  id: emailPath, filename: emailPath, loaded: true, children: [], paths: [],
  exports: {
    dispatchEmail: async ({ to, subject }) => { mailed.push({ to, subject }); return { ok: true }; },
  },
};

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${name}`); return; }
  failures++;
  console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

const toBuf = (d) => (d?.buffer ? Buffer.from(d.buffer) : Buffer.from(d));

/** Run a controller with a fake `res` and resolve with whatever it json()'d. */
function capture(fn) {
  return new Promise((resolve, reject) => {
    const res = {
      json: (body) => resolve(body),
      status: (code) => ({ json: (body) => reject(new Error(`status ${code}: ${JSON.stringify(body)}`)) }),
      setHeader: () => {}, send: () => {},
    };
    Promise.resolve(fn(res)).catch(reject);
  });
}

async function main() {
  const mongod = await MongoMemoryServer.create({ instance: { dbName: 'payslip_versioning_test' } });
  const uri = mongod.getUri();
  if (!/127\.0\.0\.1|localhost/.test(uri)) throw new Error(`refusing to run against a non-local database: ${uri}`);
  process.env.MONGODB_URI = uri;
  process.env.JWT_SECRET = 'test-secret';
  await mongoose.connect(uri);

  const {
    Branch, Employee, User, SavedPayslip, SavedPayslipVersion, PayrollMonth,
  } = require('../src/models');
  const {
    deliverPayslipToEmployee, archiveManagerPayslipPage, listBranchPayslips,
  } = require('../src/controllers/payslipAudit.controller');
  const { myPayslips } = require('../src/controllers/payroll.controller');

  const branch = await Branch.create({ name: 'הרצליה הרצוג' });
  const user = await User.create({
    full_name: 'דנה כהן', email: 'dana@example.com', password_hash: 'not-used-here',
    role: 'teacher', is_active: true,
  });
  const emp = await Employee.create({
    full_name: 'דנה כהן', israeli_id: '12345678', branch_id: branch._id,
    email: 'dana@example.com', is_active: true, user_id: user._id,
  });
  const month = '2026-08';
  // The delivery marks the month paid with a plain update (no upsert) — the row
  // exists in production because the payroll month is built long before the
  // payslip goes out. Build it here too, or the assertion tests nothing.
  await PayrollMonth.create({ employee_id: emp._id, branch_id: branch._id, month });

  const V1 = Buffer.from('PAYSLIP-V1-original-bytes');
  const V2 = Buffer.from('PAYSLIP-V2-corrected-bytes');
  const V3 = Buffer.from('PAYSLIP-V3-corrected-again');
  const MGR = Buffer.from('PAYSLIP-manager-bundle-page');

  const send = (pageBuf, page = 1) => deliverPayslipToEmployee({
    emp, month, pageBuf, branch: branch.name, page, includeHours: false,
  });
  const row = () => SavedPayslip.findOne({ employee_id: emp._id, year_month: month }).lean();
  const history = () => SavedPayslipVersion
    .find({ employee_id: emp._id, year_month: month }).sort({ version: 1 }).lean();

  // ── 1. First send ────────────────────────────────────────────────────────
  console.log('\n1. השליחה הראשונה');
  await send(V1);
  let r = await row();
  check('התלוש נשמר עם הבייטים ששלחנו', !!r && toBuf(r.data).equals(V1));
  check('delivered_to_employee = true', r?.delivered_to_employee === true);
  check('version = 1', r?.version === 1, `version=${r?.version}`);
  check('replaced_at ריק — שום דבר לא הוחלף', r?.replaced_at == null, String(r?.replaced_at));
  check('אין היסטוריה', (await history()).length === 0);

  // ── 2. Re-send of the same bytes ─────────────────────────────────────────
  console.log('\n2. שליחה חוזרת של אותם בייטים — לא החלפה');
  await send(V1);
  r = await row();
  check('version נשאר 1', r?.version === 1, `version=${r?.version}`);
  check('replaced_at נשאר ריק', r?.replaced_at == null);
  check('לא נוצרה רשומת היסטוריה', (await history()).length === 0);

  // ── 3. The corrected payslip ─────────────────────────────────────────────
  console.log('\n3. תלוש מחליף אחרי שהתלוש כבר נשלח');
  await send(V2, 4);
  r = await row();
  check('התלוש הפעיל הוא החדש', !!r?.data && toBuf(r.data).equals(V2));
  check('version = 2', r?.version === 2, `version=${r?.version}`);
  check('replaced_at מסומן', r?.replaced_at instanceof Date);

  let h = await history();
  check('נוצרה רשומת היסטוריה אחת', h.length === 1, `got ${h.length}`);
  check('הבייטים הישנים שמורים במלואם', !!h[0]?.data && toBuf(h[0].data).equals(V1));
  check('הגרסה הישנה היא 1', h[0]?.version === 1);
  check('הגרסה הישנה מסומנת superseded_at', h[0]?.superseded_at instanceof Date);
  check('ההיסטוריה זוכרת למי נשלחה הגרסה הישנה', h[0]?.sent_to === 'dana@example.com');

  // The employee's own screen must say it.
  const empRes = await capture((res) => myPayslips({ user: { id: String(user._id) } }, res, (e) => { throw e; }));
  const mine = (empRes?.payslips || []).find((p) => p.year_month === month);
  check('"התלושים שלי" מחזיר version = 2', mine?.version === 2, `version=${mine?.version}`);
  check('"התלושים שלי" מחזיר replaced = true', mine?.replaced === true);
  check('"התלושים שלי" מחזיר replaced_at', !!mine?.replaced_at);

  // And so must the managers' screen.
  const mgrRes = await capture((res) => listBranchPayslips({ user: { role: 'system_admin' }, query: {} }, res));
  const mgrEmp = (mgrRes?.employees || []).find((e) => String(e.id) === String(emp._id));
  const mgrSlip = (mgrEmp?.payslips || []).find((p) => p.year_month === month);
  check('"תלושי עובדים" מחזיר version = 2', mgrSlip?.version === 2, `version=${mgrSlip?.version}`);
  check('"תלושי עובדים" מחזיר replaced = true', mgrSlip?.replaced === true);

  // ── 4. A second correction ───────────────────────────────────────────────
  console.log('\n4. תיקון שני');
  await send(V3, 4);
  r = await row();
  check('version = 3', r?.version === 3, `version=${r?.version}`);
  check('התלוש הפעיל הוא השלישי', !!r?.data && toBuf(r.data).equals(V3));
  h = await history();
  check('שתי רשומות היסטוריה', h.length === 2, `got ${h.length}`);
  check('גרסה 1 עדיין קריאה במלואה', !!h[0]?.data && toBuf(h[0].data).equals(V1));
  check('גרסה 2 שמורה במלואה', !!h[1]?.data && toBuf(h[1].data).equals(V2));

  // ── 5. A manager-copy archive over a delivered row ───────────────────────
  console.log('\n5. ארכוב עותק המנהלת על תלוש שכבר נמסר');
  const replacedAtBefore = r?.replaced_at?.getTime();
  await archiveManagerPayslipPage({
    employeeId: emp._id, israeliId: emp.israeli_id, month, pageBuf: MGR,
    page: 9, branchLabel: branch.name, auditId: null, userId: null,
    managerEmails: 'mgr@example.com',
  });
  r = await row();
  h = await history();
  check('הבייטים של גרסה 3 נשמרו ולא נמחקו',
    h.length === 3 && !!h[2]?.data && toBuf(h[2].data).equals(V3), `history=${h.length}`);
  check('replaced_at לא זז — העובדת לא קיבלה את חבילת המנהלת',
    r?.replaced_at?.getTime() === replacedAtBefore, `${r?.replaced_at} != ${new Date(replacedAtBefore)}`);
  check('delivered_to_employee נשאר true', r?.delivered_to_employee === true);
  check('העותק של המנהלת רשום', !!r?.manager_sent_at);

  // ── Existing behaviour that must survive ─────────────────────────────────
  console.log('\n6. התנהגות קיימת');
  const pm = await PayrollMonth.findOne({ employee_id: emp._id, month }).lean();
  check('החודש עדיין מסומן שולם', pm?.payslip_paid === true);
  check('ארבעה מיילים יצאו (V1, V1 חוזר, V2, V3)', mailed.length === 4, `mailed=${mailed.length}`);

  await mongoose.disconnect();
  await mongod.stop();
  console.log(failures ? `\n${failures} בדיקות נכשלו` : '\nהכל עבר');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
