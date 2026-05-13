/**
 * For every archived (is_active=false) employee, count punches in the last
 * 60 days. Employees with recent punches are probably still working and
 * should be moved back to active. Pass --apply to flip is_active=true on all
 * of them.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { Employee, Punch } = require('../src/models');

async function main() {
  const apply = process.argv.includes('--apply');
  await mongoose.connect(process.env.MONGODB_URI);

  const since = new Date();
  since.setDate(since.getDate() - 60);

  const archived = await Employee.find({ is_active: false }).select('_id full_name israeli_id branch_id').lean();
  console.log(`Archived employees: ${archived.length}`);

  const recent = [];
  for (const emp of archived) {
    const count = await Punch.countDocuments({
      employee_id: emp._id,
      timestamp: { $gte: since },
      ignored: { $ne: true },
    });
    if (count > 0) {
      recent.push({ emp, count });
      console.log(`  ${emp.israeli_id} ${emp.full_name} — ${count} punches in last 60d`);
    }
  }
  console.log(`\n${recent.length} archived employees have recent punches`);
  if (apply && recent.length > 0) {
    await Employee.updateMany(
      { _id: { $in: recent.map(r => r.emp._id) } },
      { $set: { is_active: true } },
    );
    console.log(`Reactivated ${recent.length} employees.`);
  } else if (!apply) {
    console.log('Pass --apply to flip is_active=true on these employees.');
  }

  await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
