#!/usr/bin/env node
/**
 * Friday from 12:00: a branch whose next-week rota is not published gets one
 * push to its managers — once, not every hour.
 *
 *   node scripts/shift-reminder.test.js
 */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let failures = 0;
const eq = (a, b, l) => { const g = a === b; console.log(`  ${g ? '✅' : '❌'} ${l}${g ? '' : ` (${a} ≠ ${b})`}`); if (!g) failures++; };

(async () => {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  const { Branch, User, ShiftWeek, NotificationEvent } = require('../src/models');
  const { tick } = require('../src/services/shiftReminderJob');

  const a = await Branch.create({ name: 'כפר סבא - קפלן', is_active: true });
  const b = await Branch.create({ name: 'הרצליה הרצוג', is_active: true });
  const c = await Branch.create({ name: 'פתח תקווה', is_active: true });
  const d = await Branch.create({ name: 'קריית מוצקין', is_active: false });
  await User.create({ full_name: 'מנהלת א', id_number: '900000011', email: 'a@x.l', password_hash: 'x', role: 'branch_manager', is_active: true, managed_branch_ids: [a._id] });
  await User.create({ full_name: 'מנהלת ב', id_number: '900000012', email: 'b@x.l', password_hash: 'x', role: 'branch_manager', is_active: true, managed_branch_ids: [b._id] });
  await User.create({ full_name: 'מנהל מערכת', id_number: '900000010', email: 'admin@x.l', password_hash: 'x', role: 'system_admin', is_active: true });
  // Branch B already published next week (Friday 2026-10-09 → next Sunday 2026-10-11).
  // Branch C has no manager. Branch D is inactive.
  await ShiftWeek.create({ branch_id: b._id, week_start: '2026-10-11', published_at: new Date() });

  const thursdayNoon = new Date('2026-10-08T10:00:00Z'); // 13:00 IL, Thursday
  const fridayMorning = new Date('2026-10-09T07:00:00Z'); // 10:00 IL
  const fridayAfternoon = new Date('2026-10-09T10:30:00Z'); // 13:30 IL

  eq((await tick(thursdayNoon)).skipped, 'not friday noon', 'חמישי — כלום');
  eq((await tick(fridayMorning)).skipped, 'not friday noon', 'שישי בבוקר — כלום');
  const r = await tick(fridayAfternoon);
  eq(r.reminded, 1, 'שישי 13:30 — רק סניף א (סניף ג ללא מנהלת, סניף ד לא פעיל)');
  eq(await NotificationEvent.countDocuments({ type: 'shift_close_reminder' }), 1, 'התראה אחת — לא לנציג מערכת או לסניף ללא מנהלת');
  eq((await tick(new Date('2026-10-09T11:30:00Z'))).skipped, 'already ran', 'ריצה נוספת באותו שבוע — כלום');

  await mongoose.disconnect();
  await mongod.stop();
  console.log(failures ? `\n${failures} FAILED` : '\nכל הבדיקות עברו');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
