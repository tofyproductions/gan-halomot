/**
 * Put both parents on every child that has two.
 *
 * A registration carries one parent — whoever filled the form. When the other
 * parent signs the following year, their name, ID and phone land on a second
 * registration and nothing connects the two: אמרי נוטי is registered by
 * שי נוטי for one year and by סברינה נוטי for the next. The child record for
 * each year names one of them and does not know the other exists.
 *
 * From here on the child records are written with both (household.service.js).
 * This fills in the ones already saved.
 *
 *   node scripts/backfill-second-parent.js          # report only
 *   node scripts/backfill-second-parent.js --write  # apply
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { Registration, Child } = require('../src/models');
const { otherParentOf } = require('../src/services/household.service');

const WRITE = process.argv.includes('--write');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);

  const regs = await Registration.find({}).lean();
  const children = await Child.find({}).lean();
  const regById = new Map(regs.map(r => [String(r._id), r]));

  let found = 0;
  let written = 0;

  for (const child of children) {
    // A parent2 already on the record came from the family. Leave it.
    if (child.parent2_name || child.parent2_phone) continue;

    const reg = regById.get(String(child.registration_id));
    if (!reg) continue;

    const other = otherParentOf(reg, regs);
    if (!other) continue;

    found += 1;
    console.log(`${child.child_name} (${child.academic_year}): ${reg.parent_name} + ${other.parent2_name}`);

    if (WRITE) {
      await Child.updateOne({ _id: child._id }, {
        $set: {
          ...other,
          // The signing parent's own ID is often missing from the child record
          // too — it only ever lived on the registration.
          parent_id_number: child.parent_id_number || reg.parent_id_number || null,
        },
      });
      written += 1;
    }
  }

  console.log(`\n${found} children have a second parent in the system.`);
  console.log(WRITE ? `${written} updated.` : 'Dry run — pass --write to apply.');

  await mongoose.disconnect();
})().catch((err) => { console.error(err); process.exit(1); });
