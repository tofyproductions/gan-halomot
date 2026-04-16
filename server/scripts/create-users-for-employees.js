#!/usr/bin/env node
/**
 * One-time migration: create User accounts for all existing employees.
 * Username = full_name, password = israeli_id (ת"ז)
 *
 * Usage: node scripts/create-users-for-employees.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const Employee = require('../src/models/Employee');
const User = require('../src/models/User');

const MONGODB_URI = process.env.MONGODB_URI;

async function run() {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB');

  const employees = await Employee.find({ israeli_id: { $ne: null, $ne: '' }, is_active: true }).lean();
  console.log(`Found ${employees.length} active employees with israeli_id`);

  let created = 0, skipped = 0, linked = 0, errors = 0;

  for (const emp of employees) {
    const normalizedId = emp.israeli_id.replace(/\D/g, '').padStart(9, '0');

    // Check if User already exists
    let user = await User.findOne({ id_number: normalizedId });

    if (!user) {
      try {
        const hash = await bcrypt.hash(normalizedId, 10);
        user = await User.create({
          email: `${normalizedId}@gan-halomot.local`,
          password_hash: hash,
          full_name: emp.full_name,
          id_number: normalizedId,
          role: 'teacher', // default, change manually as needed
          branch_id: emp.branch_id,
          position: emp.position || '',
          is_active: true,
        });
        console.log(`  ✅ Created User for ${emp.full_name} (${normalizedId})`);
        created++;
      } catch (err) {
        if (err.code === 11000) {
          console.log(`  ⚠️  Duplicate email/id for ${emp.full_name}, skipping`);
          skipped++;
        } else {
          console.error(`  ❌ Error for ${emp.full_name}: ${err.message}`);
          errors++;
        }
        continue;
      }
    } else {
      console.log(`  ⏭️  User already exists for ${emp.full_name}`);
      skipped++;
    }

    // Link Employee.user_id if not already linked
    if (user && !emp.user_id) {
      await Employee.findByIdAndUpdate(emp._id, { user_id: user._id });
      linked++;
    }
  }

  console.log(`\nDone! Created: ${created}, Skipped: ${skipped}, Linked: ${linked}, Errors: ${errors}`);
  await mongoose.disconnect();
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
