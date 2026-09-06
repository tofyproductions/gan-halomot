/**
 * A throwaway server + database for store screenshots, entirely invented.
 *
 * Production has real children's names, real ID numbers, real medical
 * notes — none of that may ever reach a public store listing page. This
 * script starts an in-memory MongoDB (mongodb-memory-server — a real mongod
 * binary, just ephemeral and local, not a system install), seeds it with
 * fabricated branches/staff/children/parents, and then boots the real
 * server against it. Nothing here is written to disk once the process exits.
 *
 * Usage: node scripts/demo-server.js
 * Leaves the API listening on :3001, same as normal dev.
 */

const { MongoMemoryServer } = require('mongodb-memory-server');
const bcrypt = require('bcryptjs');

const DEMO_PASSWORD = 'demo1234';

async function main() {
  const mongod = await MongoMemoryServer.create({ instance: { dbName: 'gan_demo' } });
  const uri = mongod.getUri();

  process.env.MONGODB_URI = uri;
  process.env.JWT_SECRET = 'demo-screenshot-secret';
  process.env.PARENT_SECRET = 'demo-screenshot-parent-secret';
  process.env.DISABLE_JOBS = '1';
  process.env.PORT = '3001';
  process.env.FRONTEND_URL = 'http://localhost:4173';

  const mongoose = require('mongoose');
  await mongoose.connect(uri);
  await seed();
  await mongoose.disconnect();

  console.log('Demo database seeded. Starting server on :3001 ...');
  require('../src/index.js');
}

async function seed() {
  const {
    User, Branch, Classroom, Employee, Registration, Child, ParentAccount,
  } = require('../src/models');

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);

  const branch = await Branch.create({
    name: 'גן החלומות — הדגמה',
    address: 'רחוב הדוגמה 1, כפר סבא',
  });

  const classrooms = await Classroom.insertMany([
    { name: 'פרפרים', academic_year: '2026-2027', branch_id: branch._id },
    { name: 'דובונים', academic_year: '2026-2027', branch_id: branch._id },
    { name: 'כוכבים', academic_year: '2026-2027', branch_id: branch._id },
  ]);

  // Staff logins
  const manager = await User.create({
    email: 'manager@demo.local', password_hash: passwordHash, password_set: true,
    full_name: 'רותי לוי', role: 'branch_manager', branch_id: branch._id,
    managed_branch_ids: [branch._id], phone: '050-1234567', id_number: '000000010',
    position: 'מנהלת סניף', is_active: true,
  });
  const teacherUser = await User.create({
    email: 'teacher@demo.local', password_hash: passwordHash, password_set: true,
    full_name: 'מיכל אברהם', role: 'teacher', branch_id: branch._id,
    phone: '050-2345678', id_number: '000000020', position: 'גננת',
    is_active: true,
  });

  const staffNames = [
    { full_name: 'מיכל אברהם', position: 'גננת', role: 'teacher', user_id: teacherUser._id },
    { full_name: 'דנה שרון', position: 'גננת', role: 'teacher' },
    { full_name: 'נועה פרידמן', position: 'סייעת', role: 'assistant' },
    { full_name: 'יעל ברק', position: 'סייעת', role: 'assistant' },
    { full_name: 'שירה כהן', position: 'טבחית', role: 'cook' },
    { full_name: 'רותי לוי', position: 'מנהלת סניף', role: 'branch_manager', user_id: manager._id },
  ];

  const employees = [];
  for (let i = 0; i < staffNames.length; i++) {
    const s = staffNames[i];
    const emp = await Employee.create({
      full_name: s.full_name,
      israeli_id: String(100000001 + i),
      phone: `050-${3000000 + i}`,
      email: `${s.full_name.split(' ')[0]}@demo.local`,
      position: s.position,
      branch_id: branch._id,
      user_id: s.user_id || null,
      salary_type: 'hourly',
      hourly_rate: 45 + i,
      is_active: true,
      start_date: new Date('2024-09-01'),
    });
    employees.push(emp);
  }

  await Classroom.findByIdAndUpdate(classrooms[0]._id, { lead_employee_id: employees[0]._id, lead_teacher_id: teacherUser._id });
  await Classroom.findByIdAndUpdate(classrooms[1]._id, { lead_employee_id: employees[1]._id });

  // Attendance history — last 10 workdays, two punches each, for the visible staff
  const Punch = require('../src/models/Punch');
  const punchDocs = [];
  for (const emp of employees.slice(0, 4)) {
    for (let d = 1; d <= 10; d++) {
      const day = new Date(); day.setDate(day.getDate() - d);
      if (day.getDay() === 5 || day.getDay() === 6) continue; // skip Fri/Sat
      const inTime = new Date(day); inTime.setHours(7, 45, 0, 0);
      const outTime = new Date(day); outTime.setHours(16, 30, 0, 0);
      punchDocs.push({ branch_id: branch._id, employee_id: emp._id, israeli_id: emp.israeli_id, device_user_sn: punchDocs.length + 1, timestamp: inTime, timestamp_source: 'device', state: 0, approval_status: 'auto' });
      punchDocs.push({ branch_id: branch._id, employee_id: emp._id, israeli_id: emp.israeli_id, device_user_sn: punchDocs.length + 1, timestamp: outTime, timestamp_source: 'device', state: 1, approval_status: 'auto' });
    }
  }
  await Punch.insertMany(punchDocs);

  // Children + parents
  const childNames = [
    ['נועם', 'כהן'], ['איתי', 'לוי'], ['תמר', 'מזרחי'], ['יובל', 'פרץ'],
    ['אביגיל', 'ביטון'], ['עומר', 'אזולאי'], ['הילה', 'דהן'], ['רוני', 'גבאי'],
    ['ליאם', 'חדד'], ['שירה', 'אוחיון'], ['דניאל', 'סבן'], ['מאיה', 'עמר'],
  ];

  let demoParentAccount = null;
  for (let i = 0; i < childNames.length; i++) {
    const [first, last] = childNames[i];
    const classroom = classrooms[i % classrooms.length];
    const parentFirst = ['אורית', 'משה', 'שרה', 'דוד'][i % 4];
    const idNum = String(200000001 + i);

    const registration = await Registration.create({
      unique_id: `DEMO-${1000 + i}`,
      branch_id: branch._id,
      child_name: `${first} ${last}`,
      classroom_id: classroom._id,
      parent_name: `${parentFirst} ${last}`,
      parent_id_number: idNum,
      parent_phone: `052-${4000000 + i}`,
      parent_email: `${parentFirst}${i}@demo.local`,
      monthly_fee: 2200 + (i % 3) * 150,
      start_date: new Date('2026-09-01'),
      end_date: new Date('2027-06-30'),
      status: 'completed',
    });

    await Child.create({
      registration_id: registration._id,
      child_name: `${first} ${last}`,
      birth_date: new Date(2022 - (i % 2), i % 12, 10),
      classroom_id: classroom._id,
      academic_year: '2026-2027',
      father_name: `${parentFirst} ${last}`,
      father_id_number: idNum,
      father_phone: `052-${4000000 + i}`,
      is_active: true,
    });

    if (i === 0) {
      demoParentAccount = await ParentAccount.create({
        id_number: idNum,
        phone: `052-${4000000 + i}`,
        full_name: `${parentFirst} ${last}`,
        password_hash: passwordHash,
        activated: true,
        is_active: true,
      });
    }
  }

  console.log('--- Demo accounts ---');
  console.log(`Staff manager login: שם מלא "רותי לוי", ת.ז 000000010, סיסמה ${DEMO_PASSWORD}`);
  console.log(`Parent login: ת.ז 200000001, סיסמה ${DEMO_PASSWORD}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
