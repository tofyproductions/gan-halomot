require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

async function seed() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    const { User, Branch, Classroom, Registration, Child } = require('../src/models');

    // Create admin user
    const existingUser = await User.findOne({ email: 'admin@ganhalomot.co.il' });
    if (!existingUser) {
      const hash = await bcrypt.hash('admin123', 10);
      await User.create({
        email: 'admin@ganhalomot.co.il',
        password_hash: hash,
        full_name: 'מנהל המערכת',
        role: 'admin',
      });
      console.log('Admin user created: admin@ganhalomot.co.il / admin123');
    } else {
      console.log('Admin user already exists');
    }

    // Create branches
    const branchNames = [
      { name: 'כפר סבא - קפלן', address: 'רח׳ קפלן, כפר סבא' },
      { name: 'כפר סבא - משה דיין', address: 'רח׳ משה דיין, כפר סבא' },
      { name: 'תל אביב', address: 'תל אביב' },
      { name: 'הרצליה', address: 'הרצליה' },
    ];

    const branchMap = {};
    for (const b of branchNames) {
      let branch = await Branch.findOne({ name: b.name });
      if (!branch) {
        branch = await Branch.create(b);
        console.log(`Branch created: ${b.name}`);
      } else {
        console.log(`Branch already exists: ${b.name}`);
      }
      branchMap[b.name] = branch._id;
    }

    // Assign existing classrooms to "כפר סבא - קפלן" branch
    const kaplanId = branchMap['כפר סבא - קפלן'];
    const unassignedClassrooms = await Classroom.find({ branch_id: null });
    if (unassignedClassrooms.length > 0) {
      await Classroom.updateMany({ branch_id: null }, { branch_id: kaplanId });
      console.log(`Assigned ${unassignedClassrooms.length} classrooms to כפר סבא - קפלן`);
    }

    // Assign existing registrations to "כפר סבא - קפלן" branch
    const unassignedRegs = await Registration.find({ branch_id: null });
    if (unassignedRegs.length > 0) {
      await Registration.updateMany({ branch_id: null }, { branch_id: kaplanId });
      console.log(`Assigned ${unassignedRegs.length} registrations to כפר סבא - קפלן`);
    }

    // Create classrooms for new branches (current academic year)
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const isAfterCutoff = month > 8 || (month === 8 && now.getDate() >= 10);
    const startYear = isAfterCutoff ? year : year - 1;
    const academicYear = `${startYear}-${startYear + 1}`;

    const classroomNames = ['תינוקייה א', 'תינוקייה ב', 'צעירים', 'בוגרים'];

    for (const [bName, bId] of Object.entries(branchMap)) {
      if (bName === 'כפר סבא - קפלן') continue; // Already has classrooms
      for (const cName of classroomNames) {
        const existing = await Classroom.findOne({ name: cName, academic_year: academicYear, branch_id: bId });
        if (!existing) {
          await Classroom.create({ name: cName, academic_year: academicYear, capacity: 35, branch_id: bId });
        }
      }
      console.log(`Classrooms created for ${bName}`);
    }

    console.log('\nSeed completed!');
    process.exit(0);
  } catch (error) {
    console.error('Seed error:', error);
    process.exit(1);
  }
}

seed();
