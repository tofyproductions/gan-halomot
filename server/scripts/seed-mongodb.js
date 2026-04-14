require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

async function seed() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    const { User, Branch, Classroom, Registration, Child } = require('../src/models');

    // Create admin user
    // Create system admin users (login with ID number + password)
    const admins = [
      { full_name: 'בן כהן', id_number: '203626296', email: 'ben@ganhalomot.co.il', position: 'מנהל ראשי' },
      { full_name: 'עמית קוחטה', id_number: '324235241', email: 'amit@ganhalomot.co.il', position: 'מנהל ראשי' },
      { full_name: 'אורלי מור', id_number: '024073124', email: 'orly@ganhalomot.co.il', position: 'מנהלת חשבונות' },
    ];

    const hash = await bcrypt.hash('admin123', 10);

    for (const admin of admins) {
      const existing = await User.findOne({ id_number: admin.id_number });
      if (!existing) {
        await User.create({
          ...admin,
          password_hash: hash,
          role: 'system_admin',
        });
        console.log(`Admin created: ${admin.full_name} (ת.ז ${admin.id_number}) / סיסמה: admin123`);
      } else {
        // Update role if needed
        if (existing.role !== 'system_admin') {
          existing.role = 'system_admin';
          existing.full_name = admin.full_name;
          existing.position = admin.position;
          await existing.save();
          console.log(`Admin updated: ${admin.full_name}`);
        } else {
          console.log(`Admin exists: ${admin.full_name}`);
        }
      }
    }

    // Deactivate old email-based admin if exists
    const oldAdmin = await User.findOne({ email: 'admin@ganhalomot.co.il', id_number: '' });
    if (oldAdmin) {
      oldAdmin.is_active = false;
      await oldAdmin.save();
      console.log('Deactivated old admin (email-based)');
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

    // Create default supplier
    const { Supplier } = require('../src/models');
    const existingSupplier = await Supplier.findOne({ name: 'שבי - שיווק מזון' });
    if (!existingSupplier) {
      await Supplier.create({
        name: 'שבי - שיווק מזון',
        contact_name: 'מאיר',
        contact_phone: '052-5075834',
        contact_email: '',
        customer_name: 'גן החלומות',
        customer_id: '580757805',
        min_order_amount: 1200,
        vat_rate: 1.18,
      });
      console.log('Supplier created: שבי - שיווק מזון');
    } else {
      console.log('Supplier already exists: שבי - שיווק מזון');
    }

    console.log('\nSeed completed!');
    process.exit(0);
  } catch (error) {
    console.error('Seed error:', error);
    process.exit(1);
  }
}

seed();
