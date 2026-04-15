/**
 * One-off: seed the Moshe Dayan Branch with the 26 clock users we dumped
 * earlier, and fix Orly Mor's israeli_id to the value the clock actually
 * reports (024073124 — the clock drops leading zero, we pad on read).
 */
require('dotenv').config();
const mongoose = require('mongoose');

// Dumped from gan-pi-1, April 15 2026. Normalized: userId padded to 9 digits
// where the device returned 8. Names are omitted because the TANDEM4 PRO
// firmware returns them garbled.
const CLOCK_USERS = [
  { uid: 1,  user_id: '309694834', password: '2921' },
  { uid: 2,  user_id: '301019964', password: '4552' },
  { uid: 3,  user_id: '316942879', password: '9351' },
  { uid: 5,  user_id: '213807696', password: '7545' },
  { uid: 6,  user_id: '024073124', password: '5443' }, // אורלי מור
  { uid: 7,  user_id: '204635106', password: '7155' },
  { uid: 10, user_id: '217249259', password: '8365' },
  { uid: 12, user_id: '037576089', password: '6984' },
  { uid: 13, user_id: '038724761', password: '7945' },
  { uid: 16, user_id: '203745955', password: '7800' },
  { uid: 21, user_id: '054606827', password: '9656' },
  { uid: 22, user_id: '314090507', password: '1046', cardno: 11906508 },
  { uid: 29, user_id: '025566233', password: '1976' },
  { uid: 32, user_id: '306686452', password: '9479' },
  { uid: 38, user_id: '023806615', password: '1643' },
  { uid: 46, user_id: '057821860', password: '3191' },
  { uid: 49, user_id: '034567974', password: '1406' },
  { uid: 50, user_id: '213131501', password: '3973' },
  { uid: 53, user_id: '317034213', password: '1299' },
  { uid: 54, user_id: '037473097', password: '6549' },
  { uid: 55, user_id: '216906396', password: '6195' },
  { uid: 57, user_id: '327941274', password: '8854' },
  { uid: 58, user_id: '326303146', password: '6424' },
  { uid: 59, user_id: '314874413', password: '5469' },
  { uid: 60, user_id: '328286182', password: '7075' },
  { uid: 61, user_id: '324235241', password: '7001' }, // עמית
];

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const { Branch, Employee, Punch } = require('../src/models');

  const md = await Branch.findOne({ name: 'כפר סבא - משה דיין' });
  if (!md) throw new Error('branch not found');

  md.clock_users = CLOCK_USERS;
  md.clock_users_updated_at = new Date();
  await md.save();
  console.log(`Seeded ${CLOCK_USERS.length} clock users on ${md.name}`);

  // Fix Orly's israeli_id to the clock's value.
  const orly = await Employee.findOne({ full_name: /^אורלי מור$/ });
  if (orly) {
    const before = orly.israeli_id;
    orly.israeli_id = '024073124';
    await orly.save(); // triggers the post-save hook → auto-relinks orphan punches
    console.log(`Orly israeli_id: "${before}" -> "${orly.israeli_id}"`);
    const linked = await Punch.countDocuments({ employee_id: orly._id });
    console.log(`Punches now linked to Orly: ${linked}`);
  } else {
    console.log('Orly not found');
  }

  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
