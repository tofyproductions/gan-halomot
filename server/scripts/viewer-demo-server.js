/**
 * A throwaway server + database for smoke-testing the `admin_viewer` role in
 * a real browser, entirely invented.
 *
 * Same shape as scripts/demo-server.js (in-memory MongoDB via
 * mongodb-memory-server, seed, then boot the real src/index.js) but the seed
 * here is built around the four roles that matter for admin_viewer: a
 * system_admin and accountant who can decide on proposals, the viewer
 * herself (scoped to one branch), and a branch_manager of the OTHER branch —
 * reusing the branch/role layout proven in scripts/viewer-e2e.test.js.
 *
 * Nothing here is written to disk once the process exits, and server/.env is
 * never read — MONGODB_URI etc. are set before src/index.js is required.
 *
 * Usage: node scripts/viewer-demo-server.js
 * Leaves the API listening on :3001 (same as normal dev), unless that port
 * is already taken, in which case set PORT yourself before running.
 */

const { MongoMemoryServer } = require('mongodb-memory-server');
const bcrypt = require('bcryptjs');

const DEMO_PASSWORD = 'demo1234';

async function main() {
  const mongod = await MongoMemoryServer.create({ instance: { dbName: 'gan_viewer_demo' } });
  const uri = mongod.getUri();

  process.env.MONGODB_URI = uri;
  process.env.JWT_SECRET = 'viewer-demo-secret';
  process.env.PARENT_SECRET = 'viewer-demo-parent-secret';
  process.env.DISABLE_JOBS = '1';
  process.env.PORT = process.env.PORT || '3001';
  process.env.FRONTEND_URL = 'http://localhost:5173';

  const mongoose = require('mongoose');
  await mongoose.connect(uri);
  const logins = await seed();
  await mongoose.disconnect();

  console.log(`Demo database seeded. Starting server on :${process.env.PORT} ...`);
  require('../src/index.js');

  console.log('\n--- admin_viewer demo logins (password for all: %s) ---', DEMO_PASSWORD);
  for (const l of logins) {
    console.log(`  ${l.role.padEnd(15)} full_name="${l.full_name}"  id_number=${l.id_number}  email=${l.email}`);
  }
  console.log('Log in with full name + ID number + password (POST /api/auth/login-password).');
}

async function seed() {
  const {
    User, Branch, Classroom, Employee, Punch,
  } = require('../src/models');

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);

  const branchTA = await Branch.create({ name: 'תל אביב', address: 'הרצל 1, תל אביב' });
  const branchKS = await Branch.create({ name: 'כפר סבא', address: 'ויצמן 2, כפר סבא' });

  await Classroom.create({ name: 'פרפרים', academic_year: '2026-2027', branch_id: branchTA._id });
  await Classroom.create({ name: 'דובונים', academic_year: '2026-2027', branch_id: branchKS._id });

  const mkUser = (o) => User.create({
    password_hash: passwordHash, password_set: true, is_active: true, ...o,
  });

  const admin = await mkUser({
    email: 'admin@demo.local', full_name: 'אורי מנהל (הדגמה)', id_number: '900000001',
    role: 'system_admin', branch_id: branchTA._id, position: 'מנהל מערכת',
  });
  const acc = await mkUser({
    email: 'acc@demo.local', full_name: 'חנה חשבת (הדגמה)', id_number: '900000002',
    role: 'accountant', branch_id: branchTA._id, position: 'הנהלת חשבונות',
  });
  const viewer = await mkUser({
    email: 'viewer@demo.local', full_name: 'אלעד (הדגמה)', id_number: '900000003',
    role: 'admin_viewer', branch_id: branchTA._id, managed_branch_ids: [branchTA._id],
    position: 'מנהל מערכת - לצפייה בלבד',
  });
  const manager = await mkUser({
    email: 'manager@demo.local', full_name: 'רותי מנהלת (הדגמה)', id_number: '900000004',
    role: 'branch_manager', branch_id: branchKS._id, managed_branch_ids: [branchKS._id],
    position: 'מנהלת סניף',
  });

  const mkEmp = (full_name, israeli_id, branch, position, hourly_rate) => Employee.create({
    full_name, israeli_id, phone: `050-${israeli_id.slice(-7)}`,
    email: `${israeli_id}@demo.local`, position, branch_id: branch._id,
    salary_type: 'hourly', hourly_rate, is_active: true,
    start_date: new Date('2024-09-01'),
  });

  const empTA1 = await mkEmp('דנה כהן', '310000001', branchTA, 'גננת', 52);
  const empTA2 = await mkEmp('יעל מזרחי', '310000002', branchTA, 'סייעת', 45);
  const empKS1 = await mkEmp('נועה לוי', '310000003', branchKS, 'גננת', 52);
  const empKS2 = await mkEmp('שירה אזולאי', '310000004', branchKS, 'סייעת', 45);

  // A handful of this-month punches so the payroll table for the current
  // month has real hours in it, not just zero-hour employee rows.
  const punchDocs = [];
  let sn = 1;
  for (const emp of [empTA1, empTA2, empKS1, empKS2]) {
    for (let d = 1; d <= 5; d++) {
      const day = new Date(); day.setDate(d);
      if (day > new Date()) break; // never a future punch
      if (day.getDay() === 5 || day.getDay() === 6) continue; // skip Fri/Sat
      const inTime = new Date(day); inTime.setHours(7, 45, 0, 0);
      const outTime = new Date(day); outTime.setHours(16, 30, 0, 0);
      const branchId = [empTA1, empTA2].includes(emp) ? branchTA._id : branchKS._id;
      punchDocs.push({
        branch_id: branchId, employee_id: emp._id, israeli_id: emp.israeli_id,
        device_user_sn: sn++, timestamp: inTime, timestamp_source: 'device',
        state: 0, approval_status: 'approved',
      });
      punchDocs.push({
        branch_id: branchId, employee_id: emp._id, israeli_id: emp.israeli_id,
        device_user_sn: sn++, timestamp: outTime, timestamp_source: 'device',
        state: 1, approval_status: 'approved',
      });
    }
  }
  if (punchDocs.length > 0) await Punch.insertMany(punchDocs);

  return [
    { role: admin.role, full_name: admin.full_name, id_number: admin.id_number, email: admin.email },
    { role: acc.role, full_name: acc.full_name, id_number: acc.id_number, email: acc.email },
    { role: viewer.role, full_name: viewer.full_name, id_number: viewer.id_number, email: viewer.email },
    { role: manager.role, full_name: manager.full_name, id_number: manager.id_number, email: manager.email },
  ];
}

main().catch((err) => { console.error(err); process.exit(1); });
