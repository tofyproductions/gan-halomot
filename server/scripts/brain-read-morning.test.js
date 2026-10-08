#!/usr/bin/env node
/**
 * המוח's morning reads (/api/brain/attendance, /orders, /birthdays, /shifts,
 * /signups) — the same door and the same promises as brain-read.test.js:
 *
 *   SAME KEY, SAME DOOR. 503 without BRAIN_READ_KEY, 401 with a wrong one,
 *   never a write.
 *
 *   PARAMETERS ARE REFUSED, NOT GUESSED. date = a real YYYY-MM-DD, days 1..14,
 *   /orders takes none.
 *
 *   NO PII. Closed shapes (asserted field by field), short names, and none of
 *   the seeded phones / emails / ת.ז / addresses / notes / surnames anywhere in
 *   the raw body. Test families are not counted.
 *
 *   npm install --no-save mongodb-memory-server
 *   node scripts/brain-read-morning.test.js
 */
try { require.resolve('mongodb-memory-server'); } catch {
  console.error('\n❌  חסרה חבילת הבדיקה. הרץ:\n\n   npm install --no-save mongodb-memory-server\n');
  process.exit(1);
}
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = { id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) } };

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const express = require('express');

let failures = 0;
const ok = (c, l, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${l}${c || !d ? '' : `  (${d})`}`); if (!c) failures++; };
const eq = (a, b, l) => ok(JSON.stringify(a) === JSON.stringify(b), l, `קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)}`);
const sameKeys = (o, list) => JSON.stringify(Object.keys(o).sort()) === JSON.stringify([...list].sort());

const KEY = 'brain-test-key-at-least-32-characters-long';
const DAY = '2026-10-08'; // a Thursday
const NOW = new Date('2026-10-08T06:00:00Z');

(async () => {
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  if (!/127\.0\.0\.1|localhost/.test(uri)) throw new Error('not loopback');
  await mongoose.connect(uri);
  const { Branch, Classroom, Registration, Child, Absence, Order, Supplier, ShiftWeek, Holiday, SpecialDay, ParentAccount, Employee } = require('../src/models');
  const svc = require('../src/services/brainRead.service');

  const app = express();
  app.use('/api/brain', require('../src/routes/brain.routes'));
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/brain`;
  const call = async (path, { method = 'GET', key = KEY } = {}) => {
    const r = await fetch(base + path, { method, headers: key ? { Authorization: `Bearer ${key}` } : {} });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, text, json };
  };

  // ── fixture: two branches; families loaded with PII; one test family ──
  const PII = { phone: '0541234567', email: 'secret.parent@example.com', idn: '123456789', address: 'רחוב הסוד 99',
    notes: 'הערה-פרטית-מאוד', surname: 'משפחתיקוב', parentPhone: '0527654321', staffSurname: 'עובדתיקוב', parentSurname: 'הוריקוב' };
  const b1 = await Branch.create({ name: 'כפר סבא בדיקה' });
  const b2 = await Branch.create({ name: 'תל אביב בדיקה' });
  const young = await Classroom.create({ name: 'צעירים א', category: 'צעירים', academic_year: '2026-2027', branch_id: b1._id });
  const older = await Classroom.create({ name: 'בוגרים א', category: 'בוגרים', academic_year: '2026-2027', branch_id: b2._id });
  let n = 0;
  const kid = async (first, room, extra = {}) => {
    n++;
    const reg = await Registration.create({
      unique_id: `m-${n}`, branch_id: room.branch_id, child_name: `${first} ${PII.surname}`, classroom_id: room._id, parent_name: 'הורה',
      parent_phone: PII.parentPhone, parent_id_number: `9000000${String(n).padStart(2, '0')}`, monthly_fee: 2000,
      start_date: new Date('2026-09-01'), end_date: new Date('2027-08-31'), academic_year: '2026-2027', status: 'completed',
      child_birth_date: extra.regBirth || null,
    });
    return Child.create({
      registration_id: reg._id, child_name: `${first} ${PII.surname}`, classroom_id: room._id, academic_year: '2026-2027',
      child_id_number: PII.idn, phone: PII.phone, email: PII.email, address: PII.address, notes: PII.notes,
      parent_id_number: extra.parentId || `8000000${String(n).padStart(2, '0')}`, birth_date: extra.birth || null,
      is_test_account: !!extra.test, is_active: extra.inactive ? false : true,
    });
  };
  const noa = await kid('נועה', young, { birth: new Date('2023-10-10T00:00:00Z'), parentId: '311111111' });
  const itai = await kid('איתי', young, { birth: new Date('2022-10-08T00:00:00Z') });
  await kid('גיל', young, { regBirth: new Date('2023-10-14T00:00:00Z') });
  await kid('רותם', older, { birth: new Date('2021-12-01T00:00:00Z') });
  await kid('בדיקה', young, { birth: new Date('2023-10-09T00:00:00Z'), test: true, parentId: '322222222' });
  await kid('עזב', young, { birth: new Date('2023-10-09T00:00:00Z'), inactive: true });
  await Absence.create({ child_id: noa._id, classroom_id: young._id, branch_id: b1._id, date: DAY, child_name: 'נועה', reason: PII.notes });
  await Absence.create({ child_id: itai._id, classroom_id: young._id, branch_id: b1._id, date: DAY, cancelled_at: new Date() });

  console.log('\n🧠 קריאות דוח הבוקר\n');
  console.log('הדלת');
  delete process.env.BRAIN_READ_KEY;
  for (const p of ['/attendance', '/orders', '/birthdays', '/shifts', '/signups']) eq((await call(p)).status, 503, `${p} → 503 בלי מפתח בשרת`);
  process.env.BRAIN_READ_KEY = KEY;
  for (const p of ['/attendance', '/orders', '/birthdays', '/shifts', '/signups']) {
    eq((await call(p, { key: 'wrong-key-wrong-key-wrong-key-wrong' })).status, 401, `${p} מפתח שגוי → 401`);
    for (const method of ['POST', 'PUT', 'DELETE']) { const r = await call(p, { method }); ok(r.status === 404 || r.status === 405, `${method} ${p} → ${r.status}`); }
  }

  console.log('\nפרמטרים');
  for (const bad of ['2026-13-01', '2026-02-30', '26-10-08', '2019-01-01', '2026-10-08;x', '']) eq((await call(`/attendance?date=${encodeURIComponent(bad)}`)).status, 400, `attendance date="${bad}" → 400`);
  eq((await call('/shifts?date=2026-1-8')).status, 400, 'shifts date לא חוקי → 400');
  for (const bad of ['0', '15', 'x', '7.5', '-1']) eq((await call(`/birthdays?days=${bad}`)).status, 400, `birthdays days=${bad} → 400`);
  eq((await call('/signups?days=99')).status, 400, 'signups days=99 → 400');
  eq((await call('/orders?status=draft')).status, 400, 'orders לא מקבל פרמטרים');
  eq((await call('/attendance')).status, 200, 'attendance בלי date → היום');
  eq((await call('/birthdays')).json.to >= (await call('/birthdays')).json.from, true, 'birthdays ברירת מחדל 7 ימים');

  console.log('\nנוכחות');
  const att = await call(`/attendance?date=${DAY}`);
  const ya = att.json.by_class.find(r => r.class === 'צעירים א');
  eq([ya.enrolled, ya.absent_reported, ya.expected], [3, 1, 2], 'צעירים: 3 רשומים (בלי משפחת בדיקה, בלי שעזב), דיווח היעדרות אחד (המבוטל לא נספר) → 2');
  eq(att.json.expected_total, 3, 'סה״כ צפוי 2 + 1');
  ok(att.json.by_class.every(r => sameKeys(r, ['branch', 'class', 'enrolled', 'absent_reported', 'expected', 'closed'])), 'attendance: בדיוק השדות המותרים');
  await Holiday.create({ branch_id: b2._id, academic_year: '2026-2027', name: 'סוכות', kind: 'closure', start_date: new Date('2026-10-07T00:00:00+03:00'), end_date: new Date('2026-10-09T00:00:00+03:00') });
  const att2 = await svc.attendance(DAY);
  const ob = att2.by_class.find(r => r.class === 'בוגרים א');
  eq([ob.closed, ob.expected], [true, 0], 'סניף סגור בחג → צפוי 0');

  console.log('\nהזמנות');
  const sup = await Supplier.create({ name: 'ספק ירקות', phone: PII.phone, email: PII.email });
  await Order.create({ order_number: 'ORD-1', branch_id: b1._id, supplier_id: sup._id, status: 'awaiting_approval', items: [{ name: 'עגבניות', qty: 2, total: 40 }], total_amount: 40, notes: PII.notes, created_by: `מנהלת ${PII.staffSurname}`, submitted_at: new Date('2026-10-07T08:00:00Z') });
  await Order.create({ order_number: 'ORD-2', branch_id: b1._id, supplier_id: sup._id, status: 'pending', total_amount: 10 });
  const ord = await call('/orders');
  eq(ord.json.pending_count, 1, 'רק מה שמחכה לאישור');
  eq(ord.json.pending[0], { id_short: 'ORD-1', branch: 'כפר סבא בדיקה', supplier: 'ספק ירקות', created_at: '2026-10-07T08:00:00.000Z', items_count: 1, total: 40 }, 'הזמנה: מספר, סניף, ספק, גודל');

  console.log('\nימי הולדת');
  const bd = await svc.birthdays(7, NOW);
  eq(bd.from, '2026-10-08', 'מהיום');
  eq(bd.to, '2026-10-14', 'שבעה ימים כולל היום');
  eq(bd.birthdays.map(b => [b.child, b.date, b.age]), [[`איתי ${[...PII.surname][0]}.`, '2026-10-08', 4], [`נועה ${[...PII.surname][0]}.`, '2026-10-10', 3], [`גיל ${[...PII.surname][0]}.`, '2026-10-14', 3]],
    'הבא קודם; גיל מתאריך הלידה של הרישום כשלילד אין; בלי משפחת בדיקה ובלי מי שעזב');
  eq(bd.birthdays[1].birth_date, undefined, 'אין תאריך לידה מלא בתשובה');
  ok(bd.birthdays.every(r => sameKeys(r, ['child', 'class', 'branch', 'date', 'age'])), 'birthdays: בדיוק השדות המותרים');
  eq((await svc.birthdays(3, new Date('2026-12-30T08:00:00Z'))).birthdays.length, 0, 'מעבר שנה — אין');
  await kid('שנה', older, { birth: new Date('2022-01-01T00:00:00Z') });
  eq((await svc.birthdays(3, new Date('2026-12-30T08:00:00Z'))).birthdays.map(b => b.date), ['2027-01-01'], 'מעבר שנה: 1.1 של השנה הבאה');
  await kid('מעוברת', older, { birth: new Date('2024-02-29T00:00:00Z') });
  eq((await svc.birthdays(2, new Date('2027-02-27T08:00:00Z'))).birthdays.map(b => b.date), ['2027-02-28'], '29.2 בשנה רגילה → 28.2');

  console.log('\nמשמרות');
  const emp = await Employee.create({ full_name: `דנה ${PII.staffSurname}`, branch_id: b1._id, phone: PII.phone, israeli_id: PII.idn });
  const emp2 = await Employee.create({ full_name: `רינה ${PII.staffSurname}`, branch_id: b1._id });
  await ShiftWeek.create({ branch_id: b1._id, week_start: '2026-10-04', published_at: new Date(), published: [
    { employee_id: emp._id, employee_name: `דנה ${PII.staffSurname}`, date: DAY, area: 'class', classroom_id: young._id, start_hhmm: '07:00', end_hhmm: '14:00' },
    { employee_id: emp2._id, employee_name: `רינה ${PII.staffSurname}`, date: DAY, area: 'kitchen', start_hhmm: '08:00', end_hhmm: '15:00' },
    { employee_id: emp2._id, employee_name: `רינה ${PII.staffSurname}`, date: '2026-10-09', area: 'class', classroom_id: young._id },
  ], entries: [] });
  const sh = await call(`/shifts?date=${DAY}`);
  eq(sh.json.shifts.map(s => [s.staff, s.area, s.class, s.from, s.to]), [[`דנה ${[...PII.staffSurname][0]}.`, 'class', 'צעירים א', '07:00', '14:00'], [`רינה ${[...PII.staffSurname][0]}.`, 'kitchen', null, '08:00', '15:00']], 'הסידור שפורסם, היום בלבד');
  ok(sh.json.shifts.every(r => sameKeys(r, ['branch', 'class', 'area', 'staff', 'from', 'to'])), 'shifts: בדיוק השדות המותרים');
  eq(sh.json.gaps, [], 'צעירים: 3 ילדים, אחת בכיתה — מספיק (יחס 7)');
  eq(sh.json.unpublished_branches, [], 'הסניף השני סגור בחג — לא "לא פורסם"');
  for (let i = 0; i < 6; i++) await kid(`ילד${i}`, young);
  const sh2 = await call(`/shifts?date=${DAY}`);
  eq(sh2.json.gaps, [{ branch: 'כפר סבא בדיקה', class: 'צעירים א', enrolled: 9, staff: 1, needed: 2 }], '9 ילדים, אחת בכיתה — חסרה אחת');
  await Holiday.deleteMany({});
  eq((await call(`/shifts?date=${DAY}`)).json.unpublished_branches, ['תל אביב בדיקה'], 'סניף בלי סידור שפורסם — נאמר');
  await SpecialDay.create({ name: 'יום צוות', date: DAY, branch_id: null });
  eq((await call(`/shifts?date=${DAY}`)).json.shifts, [], 'יום צוות לכל הגן — אין משמרות');

  console.log('\nהרשמות הורים');
  await ParentAccount.create({ id_number: '311111111', phone: PII.parentPhone, full_name: `מיכל ${PII.parentSurname}`, activated: true });
  await ParentAccount.create({ id_number: '322222222', phone: PII.parentPhone, full_name: `טסט ${PII.parentSurname}`, activated: true }); // test family
  await ParentAccount.create({ id_number: '333333333', phone: PII.parentPhone, full_name: `לא הפעיל ${PII.parentSurname}`, activated: false });
  const old = await ParentAccount.create({ id_number: '344444444', phone: PII.parentPhone, full_name: 'ישן', activated: true });
  await ParentAccount.collection.updateOne({ _id: old._id }, { $set: { created_at: new Date('2026-01-01') } });
  const su = await call('/signups?days=7');
  eq([su.json.days, su.json.count], [7, 1], 'רק הורה פעיל של ילד אמיתי, בחלון');
  eq(su.json.by_branch, [{ branch: 'כפר סבא בדיקה', count: 1 }], 'לפי סניף');
  eq(su.json.parents, [{ first_name: 'מיכל', branch: 'כפר סבא בדיקה' }], 'שם פרטי בלבד');

  console.log('\nאין PII');
  const bodies = [att, ord, await call(`/birthdays?days=7`), sh2, su];
  for (const r of bodies) {
    const leaked = Object.entries(PII).filter(([, v]) => r.text.includes(v)).map(([k]) => k);
    ok(leaked.length === 0, `${r.text.slice(0, 20)}…: אף ערך רגיש לא דלף`, leaked.join(','));
    ok(!/"(_id|phone|email|address|notes|parent|id_number|israeli_id|salary|reason)"/i.test(r.text), 'אין שמות שדות רגישים');
  }

  await mongoose.disconnect();
  await mongod.stop();
  server.close();
  console.log(failures ? `\n❌ ${failures} נכשלו\n` : '\n✅ הכל עבר\n');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
