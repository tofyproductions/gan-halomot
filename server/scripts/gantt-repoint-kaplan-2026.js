/**
 * One-off, 2026-09-24: move קפלן's two September 2026 plans to this year's rooms.
 *
 * The plans were saved on the 2025-2026 בוגרים and צעירים rooms. When the
 * 2026-2027 rooms of the same names were opened, the screen (rightly) showed
 * only those, and the plans looked deleted. They were not — they sit on rooms
 * the picker no longer offers. This points each plan at the room of the same
 * name in 2026-2027. Update only; nothing is deleted.
 *
 * Refuses to run if a target room already has a September plan, or if a room
 * name does not resolve to exactly one active room in its year.
 *
 *   cd server && node scripts/gantt-repoint-kaplan-2026.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  const db = mongoose.connection.db;
  const gantts = db.collection('ganttmonths');
  const classrooms = db.collection('classrooms');

  const kaplan = (await db.collection('branches').findOne({ name: 'כפר סבא - קפלן' }))?._id;
  if (!kaplan) throw new Error('הסניף כפר סבא - קפלן לא נמצא');

  const room = async (name, year) => {
    const rows = await classrooms.find({ branch_id: kaplan, name, academic_year: year, is_active: true }).toArray();
    if (rows.length !== 1) throw new Error(`ציפיתי לכיתה אחת ${name} ${year}, נמצאו ${rows.length}`);
    return rows[0];
  };

  for (const name of ['בוגרים', 'צעירים']) {
    const oldRoom = await room(name, '2025-2026');
    const newRoom = await room(name, '2026-2027');
    const plan = await gantts.findOne({ classroom_id: oldRoom._id, month: 9, year: 2026 });
    const clash = await gantts.findOne({ classroom_id: newRoom._id, month: 9, year: 2026 });
    if (!plan) throw new Error(`אין תוכנית ספטמבר על קפלן ${name} ${oldRoom.academic_year}`);
    if (clash) throw new Error(`לקפלן ${name} 2026-2027 כבר יש תוכנית ספטמבר — לא נוגע`);
    const r = await gantts.updateOne(
      { _id: plan._id },
      { $set: { classroom_id: newRoom._id, academic_year: '2026-2027' } },
    );
    console.log(`✅ קפלן ${name}: התוכנית ${plan._id} עברה לכיתה של 2026-2027 (עודכן ${r.modifiedCount})`);
  }

  await mongoose.disconnect();
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
