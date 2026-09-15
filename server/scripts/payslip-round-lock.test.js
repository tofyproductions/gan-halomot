#!/usr/bin/env node
/**
 * An approved cycle is a closed cycle — but only once it has actually left the
 * building.
 *
 * Approving a correction round promotes that round's PDFs over the audit's
 * `approved` slot, and that slot is what the distribution reads. Doing it a
 * second time, after payslips had already gone out to employees, silently
 * replaced the file the month was paid from. Nobody was told, and the previous
 * approved PDF was not recoverable.
 *
 * The lock is deliberately CONDITIONAL, because the unconditional version
 * breaks a legitimate flow: the accountant returning a second corrected file
 * before anything has been distributed is ordinary work, not an overwrite of
 * something a person is holding. So:
 *
 *   approved === false                              → passes
 *   approved === true, nothing distributed          → passes
 *   approved === true, distributed for THIS month   → 409
 *   approved === true, distributed for ANOTHER month→ passes
 *
 * That last one is the whole reason the check is scoped to the audit's
 * year_month. A query that counted distributions across all months would lock
 * September because August went out, which is every month after the first.
 *
 * Once locked, the two ways forward are named in the error itself: revoke the
 * approval explicitly, or file a per-employee replacement payslip.
 *
 *   node scripts/payslip-round-lock.test.js
 */

const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};

const emailPath = require.resolve('../src/services/email.service');
require.cache[emailPath] = {
  id: emailPath, filename: emailPath, loaded: true, children: [], paths: [],
  exports: { dispatchEmail: async () => ({ ok: true }) },
};

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const os = require('os');
const path = require('path');

// The approval writes a convenience copy to disk under DATA_DIR. Keep it out
// of the repo — it is read back from Mongo, so a temp dir costs nothing.
process.env.DATA_DIR = path.join(os.tmpdir(), `payslip-round-lock-${process.pid}`);

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${name}`); return; }
  failures++;
  console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

const toBuf = (d) => (d?.buffer ? Buffer.from(d.buffer) : Buffer.from(d));

/** Run a controller with a fake `res`; resolves {status, body} either way. */
function call(fn) {
  return new Promise((resolve, reject) => {
    const res = {
      json: (body) => resolve({ status: 200, body }),
      status: (code) => ({ json: (body) => resolve({ status: code, body }) }),
      setHeader: () => {}, send: () => {},
    };
    Promise.resolve(fn(res)).catch(reject);
  });
}

async function main() {
  const mongod = await MongoMemoryServer.create({ instance: { dbName: 'payslip_round_lock_test' } });
  const uri = mongod.getUri();
  if (!/127\.0\.0\.1|localhost/.test(uri)) throw new Error(`refusing to run against a non-local database: ${uri}`);
  process.env.MONGODB_URI = uri;
  process.env.JWT_SECRET = 'test-secret';
  await mongoose.connect(uri);

  const {
    Branch, Employee, SavedPayslip, PayslipAuditRecord, PayslipAuditPdf,
  } = require('../src/models');
  const { approveFixRound, approveAudit } = require('../src/controllers/payslipAudit.controller');

  const branch = await Branch.create({ name: 'הרצליה הרצוג' });
  const emp = await Employee.create({
    full_name: 'דנה כהן', israeli_id: '12345678', branch_id: branch._id,
    email: 'dana@example.com', is_active: true,
  });

  const APPROVED_V1 = Buffer.from('APPROVED-PDF-round-1');
  const ROUND_2 = Buffer.from('ROUND-2-PDF-bytes');

  /**
   * A fresh audit for `month` with one settled correction round waiting to be
   * approved, its round PDF stored, and an `approved` slot already holding
   * round 1's file.
   */
  async function makeAudit(month, { approved }) {
    const doc = await PayslipAuditRecord.create({
      year_month: month,
      branches: [branch.name],
      full_result: { results: [] },
      approved,
      approved_at: approved ? new Date() : null,
      fix_rounds: [{
        round_no: 2,
        source: 'accountant',
        uploaded_files: [{ branch: branch.name, filename: 'round2.pdf' }],
        // Every note settled, so nothing but the lock can produce a 409.
        items: [{
          key: 'id:012345678', employee_name: emp.full_name, branch: branch.name,
          matched: true,
          notes: [{ field: 'net_pay', severity: 'critical', message: 'נטו שגוי', auto_verdict: 'fixed' }],
        }],
      }],
    });
    await PayslipAuditPdf.create({ audit_id: doc._id, branch: branch.name, kind: 'approved', data: APPROVED_V1 });
    await PayslipAuditPdf.create({ audit_id: doc._id, branch: branch.name, kind: 'fix_2', data: ROUND_2 });
    return doc;
  }

  const approvedSlot = (doc) => PayslipAuditPdf
    .findOne({ audit_id: doc._id, branch: branch.name, kind: 'approved' }).lean();

  const req = (doc) => ({
    params: { id: String(doc._id), roundNo: '2' },
    body: {}, user: { id: null, full_name: 'בן' },
  });

  // ── 1. Not approved yet ──────────────────────────────────────────────────
  console.log('\n1. ביקורת שלא אושרה — אישור סבב עובר');
  let doc = await makeAudit('2026-08', { approved: false });
  let r = await call((res) => approveFixRound(req(doc), res));
  check('200', r.status === 200, `status=${r.status} ${JSON.stringify(r.body)}`);
  check('ה-PDF של הסבב קודם ל-approved', toBuf((await approvedSlot(doc)).data).equals(ROUND_2));

  // ── 2. Approved, nothing distributed ─────────────────────────────────────
  console.log('\n2. מאושר אבל שום דבר לא הופץ — עובר (הזרימה של רו״ח)');
  doc = await makeAudit('2026-08', { approved: true });
  r = await call((res) => approveFixRound(req(doc), res));
  check('200', r.status === 200, `status=${r.status} ${JSON.stringify(r.body)}`);
  check('ה-PDF של הסבב קודם ל-approved', toBuf((await approvedSlot(doc)).data).equals(ROUND_2));

  // ── 3. Approved, and a payslip reached an employee for ANOTHER month ─────
  //
  // The check has to be scoped to the audit's own month. Counting deliveries
  // across all months would lock September because August went out.
  console.log('\n3. מאושר, הופץ תלוש של חודש אחר — עובר');
  await SavedPayslip.create({
    employee_id: emp._id, year_month: '2026-07', branch: branch.name,
    data: Buffer.from('JULY-PAYSLIP'), delivered_to_employee: true, sent_to: emp.email,
  });
  doc = await makeAudit('2026-08', { approved: true });
  r = await call((res) => approveFixRound(req(doc), res));
  check('200 — יולי לא נועל את אוגוסט', r.status === 200, `status=${r.status} ${JSON.stringify(r.body)}`);
  check('ה-PDF של הסבב קודם ל-approved', toBuf((await approvedSlot(doc)).data).equals(ROUND_2));

  // ── 4. Approved, and this month's payslips went out ──────────────────────
  console.log('\n4. מאושר והופץ לעובדים לאותו חודש — 409');
  await SavedPayslip.create({
    employee_id: emp._id, year_month: '2026-08', branch: branch.name,
    data: Buffer.from('AUGUST-PAYSLIP'), delivered_to_employee: true, sent_to: emp.email,
  });
  doc = await makeAudit('2026-08', { approved: true });
  r = await call((res) => approveFixRound(req(doc), res));
  check('409', r.status === 409, `status=${r.status} ${JSON.stringify(r.body)}`);
  const msg = String(r.body?.error || '');
  check('ההודעה מפנה לביטול אישור', /ביטול אישור|בטל/.test(msg), msg);
  check('ההודעה מפנה לתלוש מחליף פר-עובד', /מחליף/.test(msg), msg);
  check('ה-approved לא נדרס — עדיין הקובץ של סבב 1',
    toBuf((await approvedSlot(doc)).data).equals(APPROVED_V1));
  const after = await PayslipAuditRecord.findById(doc._id).lean();
  check('הסבב לא סומן כמאושר', after.fix_rounds[0].approved !== true);

  // ── 5. A manager-only copy does not count as distributed ────────────────
  //
  // The manager distribution archives a row too, and it is explicitly NOT a
  // delivery to the employee. Locking on it would close the cycle before
  // anyone received anything.
  console.log('\n5. עותק שהגיע רק למנהלת — לא נחשב הפצה');
  await SavedPayslip.deleteMany({ year_month: '2026-09' });
  await SavedPayslip.create({
    employee_id: emp._id, year_month: '2026-09', branch: branch.name,
    data: Buffer.from('SEPT-MANAGER-COPY'), delivered_to_employee: false,
    manager_sent_to: 'mgr@example.com', manager_sent_at: new Date(),
  });
  doc = await makeAudit('2026-09', { approved: true });
  r = await call((res) => approveFixRound(req(doc), res));
  check('200 — עותק מנהלת לא נועל', r.status === 200, `status=${r.status} ${JSON.stringify(r.body)}`);

  // ── 6. approveAudit uploading over a distributed month ───────────────────
  //
  // Same slot, same overwrite, same rule. A bare re-approve that uploads
  // nothing destroys nothing and must stay allowed.
  console.log('\n6. אישור ביקורת עם העלאת קבצים על חודש שכבר הופץ');
  doc = await makeAudit('2026-08', { approved: true });
  const upReq = {
    params: { id: String(doc._id) },
    body: { approved_branch_0: branch.name },
    files: { approved_payslip_0: [{ buffer: Buffer.from('NEW-APPROVED'), originalname: 'new.pdf' }] },
    user: { id: null, full_name: 'בן' },
  };
  r = await call((res) => approveAudit(upReq, res));
  check('409', r.status === 409, `status=${r.status} ${JSON.stringify(r.body)}`);
  check('ה-approved לא נדרס', toBuf((await approvedSlot(doc)).data).equals(APPROVED_V1));

  console.log('\n7. אישור ביקורת בלי קבצים — לא דורס כלום, עובר');
  r = await call((res) => approveAudit({
    params: { id: String(doc._id) }, body: {}, files: {}, user: { id: null, full_name: 'בן' },
  }, res));
  check('200', r.status === 200, `status=${r.status} ${JSON.stringify(r.body)}`);

  await mongoose.disconnect();
  await mongod.stop();
  console.log(failures ? `\n${failures} בדיקות נכשלו` : '\nהכל עבר');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
