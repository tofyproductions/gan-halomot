/**
 * One-shot: set start_date = today − 365 days for every active employee
 * whose start_date is currently null. The manager fixes individual
 * employees afterwards from the UI.
 *
 * Usage:  node scripts/backfill-start-dates.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { Employee } = require('../src/models');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const oneYearAgo = new Date();
  oneYearAgo.setDate(oneYearAgo.getDate() - 365);

  const targets = await Employee.find({
    is_active: true,
    $or: [{ start_date: null }, { start_date: { $exists: false } }],
  }).select('_id full_name branch_id').lean();
  console.log(`Found ${targets.length} active employees without start_date`);

  let updated = 0;
  for (const e of targets) {
    await Employee.updateOne({ _id: e._id }, { $set: { start_date: oneYearAgo } });
    updated++;
  }
  console.log(`updated=${updated} → start_date=${oneYearAgo.toISOString().slice(0, 10)}`);
  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
