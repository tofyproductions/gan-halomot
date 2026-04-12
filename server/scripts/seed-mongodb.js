require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

async function seed() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    const { User, Classroom } = require('../src/models');

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

    // Create classrooms for current academic year
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const isAfterCutoff = month > 8 || (month === 8 && now.getDate() >= 10);
    const startYear = isAfterCutoff ? year : year - 1;
    const academicYear = `${startYear}-${startYear + 1}`;

    const classroomNames = ['תינוקייה א', 'תינוקייה ב', 'צעירים', 'בוגרים'];

    for (const name of classroomNames) {
      const existing = await Classroom.findOne({ name, academic_year: academicYear });
      if (!existing) {
        await Classroom.create({ name, academic_year: academicYear, capacity: 35 });
        console.log(`Classroom created: ${name} (${academicYear})`);
      } else {
        console.log(`Classroom already exists: ${name} (${academicYear})`);
      }
    }

    console.log('\nSeed completed!');
    process.exit(0);
  } catch (error) {
    console.error('Seed error:', error);
    process.exit(1);
  }
}

seed();
