#!/usr/bin/env node
/**
 * מעבר לכיתת הפעוטות — the ask, the approval, the three months after.
 *
 * The rule under test is a money rule: which room a child is in decides what
 * the family pays, so a תינוקייה board may ASK for a move but the branch
 * manager makes it. Everything here checks that ordering — nothing about the
 * child changes on the request, everything changes on the approval, and the
 * "keep on our board" answer given at request time is honoured from the day
 * of approval.
 *
 * THE DATABASE IS EPHEMERAL AND LOCAL. dotenv is stubbed before anything
 * loads it; server/.env on this machine points at production.
 *
 *   node scripts/classroom-move-e2e.test.js
 */
const net = require('net');
const http = require('http');

const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};

const { MongoMemoryServer } = require('mongodb-memory-server');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

const PASSWORD = 'test1234';
let failures = 0;
let checks = 0;

const ok = (cond, label, detail = '') => {
  checks++;
  if (cond) console.log(`  ✅ ${label}`);
  else { failures++; console.log(`  ❌ ${label}${detail ? `  (${detail})` : ''}`); }
  return !!cond;
};
const eq = (a, b, label) => ok(a === b, label, `קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)}`);
const head = (t) => console.log(`\n${t}`);

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

let PORT = 0;

function request({ method = 'GET', path, token, body }) {
  return new Promise((resolve, reject) => {
    const h = {};
    let payload = null;
    if (body !== undefined && body !== null) {
      payload = Buffer.from(JSON.stringify(body));
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = payload.length;
    }
    if (token) h.Authorization = `Bearer ${token}`;
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: json, text });
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await request({ path: '/api/health' });
      if (r.status === 200) return true;
    } catch { /* not up */ }
    await sleep(200);
  }
  throw new Error('השרת לא ענה על /api/health');
}

async function login(full_name, id_number) {
  const r = await request({
    method: 'POST', path: '/api/auth/login-password',
    body: { full_name, id_number, password: PASSWORD },
  });
  if (r.status !== 200 || !r.body?.token) throw new Error(`התחברות נכשלה: ${r.status} ${r.text}`);
  return r.body.token;
}

const daysFromNow = (iso) => Math.round((new Date(iso) - new Date()) / 86400000);

let mongod = null;
let server = null;

async function main() {
  console.log('=== מעבר לכיתת הפעוטות — בדיקת קצה-אל-קצה ===');

  mongod = await MongoMemoryServer.create({ instance: { dbName: 'gan_move_e2e' } });
  PORT = await freePort();

  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_SECRET = 'move-e2e-secret';
  process.env.PARENT_SECRET = 'move-e2e-parent-secret';
  process.env.DISABLE_JOBS = '1';
  process.env.PORT = String(PORT);
  process.env.FRONTEND_URL = 'http://localhost:4173';
  process.env.NODE_ENV = 'development';
  process.env.GC_REEXEC = '1';
  delete process.env.PLATFORM_MONGODB_URI;

  const express = require('express');
  const originalListen = express.application.listen;
  express.application.listen = function patched(...args) {
    server = originalListen.apply(this, args);
    return server;
  };
  require('../src/index.js');
  await waitForServer();
  express.application.listen = originalListen;

  const host = String(mongoose.connection.host || '');
  if (!/^(127\.0\.0\.1|localhost|::1)$/.test(host)) {
    throw new Error(`מסד הנתונים אינו מקומי (${host}) — עוצרים`);
  }
  console.log(`\nשרת עלה על :${PORT}, מסד נתונים בזיכרון (${host})`);

  const {
    User, Branch, Classroom, Child, Registration, ClassroomMoveRequest, NotificationEvent, DailyLog,
  } = require('../src/models');
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  const ks = await Branch.create({ name: 'כפר סבא - משה דיין', address: 'משה דיין 9' });
  const YEAR = '2026-2027';
  const nursery = await Classroom.create({ name: 'תינוקייה א', branch_id: ks._id, academic_year: YEAR, is_active: true });
  const toddlers = await Classroom.create({ name: 'צעירים', branch_id: ks._id, academic_year: YEAR, is_active: true });
  const older = await Classroom.create({ name: 'בוגרים', branch_id: ks._id, academic_year: YEAR, is_active: true });

  const mkChild = async (name, room, uid) => {
    const reg = await Registration.create({
      unique_id: uid, child_name: name, parent_name: `הורה של ${name}`,
      monthly_fee: 2000, branch_id: ks._id, academic_year: YEAR,
      start_date: new Date(`${YEAR.slice(0, 4)}-09-01`), end_date: new Date(`${YEAR.slice(5)}-08-31`),
      classroom_id: room._id,
    });
    return Child.create({
      registration_id: reg._id, child_name: name, classroom_id: room._id,
      branch_id: ks._id, academic_year: YEAR, is_active: true,
    });
  };
  const noa = await mkChild('נועה ברק', nursery, 'M-1');
  const dan = await mkChild('דן שגב', toddlers, 'M-2');
  await mkChild('רוני גל', older, 'M-3');

  const mkUser = (o) => User.create({ password_hash: passwordHash, password_set: true, is_active: true, ...o });
  await mkUser({
    email: 'admin@e2e.local', full_name: 'אורי מנהל', id_number: '900000001',
    role: 'system_admin', branch_id: ks._id, position: 'מנהל מערכת',
  });
  const manager = await mkUser({
    email: 'ks@e2e.local', full_name: 'לידור כהן', id_number: '900000002',
    role: 'branch_manager', branch_id: ks._id, managed_branch_ids: [ks._id], position: 'מנהלת סניף',
  });
  await mkUser({
    email: 'gan@e2e.local', full_name: 'שירה גננת', id_number: '900000003',
    role: 'teacher', branch_id: ks._id, position: 'גננת',
  });

  const adminToken = await login('אורי מנהל', '900000001');
  const managerToken = await login('לידור כהן', '900000002');
  const ganToken = await login('שירה גננת', '900000003');
  const room = String(nursery._id);

  /* ---------------------------------------------------------------- */
  head('1. הלוח היומי: פעוטות ובוגרים לא על הלוח, תינוקייה כן');
  const board0 = await request({ path: `/api/nursery/board?classroom=${room}`, token: ganToken });
  eq(board0.status, 200, 'לוח התינוקייה נטען');
  eq((board0.body?.children || []).map(c => c.name).join(','), 'נועה ברק', 'רק ילדת התינוקייה עליו');
  ok(!(board0.body?.children || []).some(c => c.carried), 'אף אחד לא מורחב עדיין');

  const candidates = await request({ path: `/api/nursery/board/candidates?classroom=${room}`, token: ganToken });
  eq(candidates.status, 200, 'רשימת המועמדים להוספה נטענת');
  const names = (candidates.body?.candidates || []).map(c => c.name);
  ok(names.includes('דן שגב'), 'ילד הפעוטות מוצע להוספה');
  ok(names.includes('רוני גל'), 'וגם ילד הבוגרים (כיתה בלי לוח משלה)');
  ok(!names.includes('נועה ברק'), 'ילדת הכיתה עצמה — לא');

  /* ---------------------------------------------------------------- */
  head('2. הוספת פעוט ללוח — 3 חודשים');
  const added = await request({
    method: 'POST', path: '/api/nursery/board/extend', token: ganToken,
    body: { classroom: room, child_id: String(dan._id) },
  });
  eq(added.status, 200, 'ההוספה הצליחה');
  eq(added.body?.months, 3, 'שלושה חודשים');
  ok(daysFromNow(added.body?.until) >= 85 && daysFromNow(added.body?.until) <= 95, `התאריך ~90 יום קדימה (${added.body?.until})`);

  const board1 = await request({ path: `/api/nursery/board?classroom=${room}`, token: ganToken });
  const danOnBoard = (board1.body?.children || []).find(c => c.name === 'דן שגב');
  ok(!!danOnBoard, 'דן מופיע על לוח התינוקייה');
  eq(danOnBoard?.carried, true, 'מסומן כמורחב');
  eq(danOnBoard?.own_classroom, 'צעירים', 'עם שם הכיתה האמיתית שלו');
  eq(danOnBoard?.board_expiring, false, 'ועדיין לא בשלושת הימים האחרונים');
  eq(String((await Child.findById(dan._id)).classroom_id), String(toddlers._id), 'הכיתה שלו לא השתנתה');

  const again = await request({
    method: 'POST', path: '/api/nursery/board/candidates?classroom=' + room, token: ganToken,
  });
  const cand2 = await request({ path: `/api/nursery/board/candidates?classroom=${room}`, token: ganToken });
  ok(!(cand2.body?.candidates || []).some(c => c.name === 'דן שגב'), 'ואינו מוצע שוב');
  void again;

  /* ---------------------------------------------------------------- */
  head('3. הגננות יכולות לעדכן את דן מהלוח הזה');
  const today = board1.body?.date;
  const patch = await request({
    method: 'PATCH', path: `/api/nursery/log/${dan._id}`, token: ganToken,
    body: { date: today, attendance: 'הגיע' },
  });
  eq(patch.status, 200, 'עדכון נוכחות לילד מורחב מתקבל');

  head('3א. נוכחות מסומנת לבד: רישום של הצוות = הגיע, הודעת הורה = לא הגיע');
  const meal = await request({
    method: 'PATCH', path: `/api/nursery/log/${noa._id}`, token: ganToken,
    body: { date: today, 'meals.breakfast.amount': '50%' },
  });
  eq(meal.status, 200, 'רישום ארוחה לנועה');
  eq(meal.body?.log?.attendance, 'הגיע', 'סומנה "הגיע" בלי שאף אחד לחץ');
  eq(meal.body?.log?.attendance_auto, true, 'ומסומן שזה אוטומטי');
  const manual = await request({
    method: 'PATCH', path: `/api/nursery/log/${noa._id}`, token: ganToken,
    body: { date: today, attendance: 'חסר' },
  });
  eq(manual.body?.log?.attendance, 'חסר', 'הגננת קבעה ידנית "לא הגיע"');
  eq(manual.body?.log?.attendance_auto, false, 'ידני — לא אוטומטי');
  const meal2 = await request({
    method: 'PATCH', path: `/api/nursery/log/${noa._id}`, token: ganToken,
    body: { date: today, 'meals.lunch.amount': '75%' },
  });
  eq(meal2.body?.log?.attendance, 'חסר', 'רישום נוסף לא דורס סימון ידני');
  // The parent's word, written straight into the log the way the portal does.
  await DailyLog.updateOne({ child_id: dan._id, date: today }, { $set: { 'home.not_coming': true, attendance: 'חסר', attendance_auto: true } }, { upsert: true });
  const danMeal = await request({
    method: 'PATCH', path: `/api/nursery/log/${dan._id}`, token: ganToken,
    body: { date: today, 'meals.breakfast.amount': '25%' },
  });
  eq(danMeal.status, 200, 'דן — ההורים אמרו לא מגיע, אבל הצוות רשם ארוחה');
  eq(danMeal.body?.log?.attendance, 'הגיע', 'העובדה המאוחרת מנצחת: הגיע');
  eq(danMeal.body?.log?.home?.not_coming, true, 'הודעת ההורים נשארת רשומה');

  head('3ב. רשומה שנכתבה לפני החוק (או מהסנכרון) מסתדרת בקריאת הלוח');
  const legacy = await Child.create({
    registration_id: noa.registration_id, child_name: 'רוני ישן', classroom_id: nursery._id,
    branch_id: ks._id, academic_year: YEAR, is_active: true,
  });
  await DailyLog.create({ child_id: legacy._id, date: today, child_name: 'רוני ישן', classroom_id: nursery._id, branch_id: ks._id, meals: { lunch: { amount: '50%', formula: '' } } });
  const boardX = await request({ path: `/api/nursery/board?classroom=${room}`, token: ganToken });
  const roni = (boardX.body?.children || []).find(c => c.name === 'רוני ישן');
  eq(roni?.log?.attendance ?? roni?.attendance, 'הגיע', 'ארוחה שנרשמה בלי החוק → הגיע בקריאה');
  eq((await DailyLog.findOne({ child_id: legacy._id, date: today }).lean()).attendance_auto, true, 'ונכתב חזרה למסד');

  /* ---------------------------------------------------------------- */
  head('4. שלושה ימים לפני הסוף — הלוח שואל; "כן" = חודש נוסף מהיום');
  const soon = new Date(); soon.setDate(soon.getDate() + 2); soon.setHours(23, 59, 59, 999);
  await Child.updateOne({ _id: dan._id }, { $set: { 'board_extension.until': soon } });
  const board2 = await request({ path: `/api/nursery/board?classroom=${room}`, token: ganToken });
  const danSoon = (board2.body?.children || []).find(c => c.name === 'דן שגב');
  eq(danSoon?.board_expiring, true, 'הכרטיס מסומן "עומד להסתיים"');

  const renewed = await request({
    method: 'POST', path: '/api/nursery/board/extend', token: ganToken,
    body: { classroom: room, child_id: String(dan._id), months: 1 },
  });
  eq(renewed.status, 200, 'ההארכה הצליחה');
  eq(renewed.body?.months, 1, 'חודש אחד');
  ok(daysFromNow(renewed.body?.until) >= 27 && daysFromNow(renewed.body?.until) <= 32, `מהיום, לא מהסוף הישן (${renewed.body?.until})`);

  head('5. "לא" = יורד מהלוח');
  const released = await request({
    method: 'POST', path: '/api/nursery/board/release', token: ganToken,
    body: { classroom: room, child_id: String(dan._id) },
  });
  eq(released.status, 200, 'ההסרה הצליחה');
  const board3 = await request({ path: `/api/nursery/board?classroom=${room}`, token: ganToken });
  ok(!(board3.body?.children || []).some(c => c.name === 'דן שגב'), 'דן כבר לא על הלוח');

  /* ---------------------------------------------------------------- */
  head('6. "העבר לכיתת הפעוטות" — בקשה, לא מעבר');
  const asked = await request({
    method: 'POST', path: '/api/nursery/board/move-request', token: ganToken,
    body: { classroom: room, child_id: String(noa._id), keep_on_board: true },
  });
  eq(asked.status, 201, 'הבקשה נרשמה');
  eq(asked.body?.to, 'צעירים', 'היעד: כיתת הפעוטות של הסניף');
  eq(String((await Child.findById(noa._id)).classroom_id), String(nursery._id), 'נועה עדיין בתינוקייה');

  const dup = await request({
    method: 'POST', path: '/api/nursery/board/move-request', token: ganToken,
    body: { classroom: room, child_id: String(noa._id), keep_on_board: false },
  });
  eq(dup.status, 409, 'בקשה שנייה לאותה ילדה נדחית');

  const board4 = await request({ path: `/api/nursery/board?classroom=${room}`, token: ganToken });
  const noaCard = (board4.body?.children || []).find(c => c.name === 'נועה ברק');
  eq(noaCard?.pending_move?.to, 'צעירים', 'הכרטיס מציג "מעבר ממתין"');

  const notif = await NotificationEvent.findOne({ type: 'child_move_request', recipient_id: manager._id }).lean();
  ok(!!notif, 'מנהלת הסניף קיבלה התראה');
  eq(notif?.resolved_at ?? null, null, 'שעדיין פתוחה');

  /* ---------------------------------------------------------------- */
  head('7. גננת לא מאשרת; מנהלת סניף כן');
  const list = await request({ path: '/api/children/move-requests?status=pending', token: ganToken });
  ok(list.status === 403 || list.body?.may_decide === false, 'גננת: רואה לכל היותר, לא מחליטה');

  const mlist = await request({ path: '/api/children/move-requests?status=pending', token: managerToken });
  eq(mlist.status, 200, 'המנהלת רואה את התור');
  eq(mlist.body?.may_decide, true, 'ומורשית להחליט');
  eq((mlist.body?.requests || []).length, 1, 'בקשה אחת');
  const reqId = mlist.body.requests[0].id;
  eq(mlist.body.requests[0].keep_on_board, true, 'עם הבקשה להשאיר בלוח');

  const approved = await request({ method: 'POST', path: `/api/children/move-requests/${reqId}/approve`, token: managerToken });
  eq(approved.status, 200, 'האישור התקבל');

  const noaAfter = await Child.findById(noa._id).lean();
  eq(String(noaAfter.classroom_id), String(toddlers._id), 'נועה עברה לצעירים');
  eq(String((await Registration.findById(noa.registration_id).lean()).classroom_id), String(toddlers._id), 'וגם הרישום שלה');
  eq(String(noaAfter.board_extension?.classroom_id), String(nursery._id), 'ונשארת על לוח התינוקייה');
  ok(daysFromNow(noaAfter.board_extension?.until) >= 85, '…לשלושה חודשים מיום האישור');

  const req1 = await ClassroomMoveRequest.findById(reqId).lean();
  eq(req1.status, 'approved', 'הבקשה מסומנת מאושרת');
  eq(req1.decided_by_name, 'לידור כהן', 'על ידי המנהלת');
  const notifAfter = await NotificationEvent.findById(notif._id).lean();
  ok(!!notifAfter.resolved_at, 'ההתראה נסגרה');

  const board5 = await request({ path: `/api/nursery/board?classroom=${room}`, token: ganToken });
  const noaCarried = (board5.body?.children || []).find(c => c.name === 'נועה ברק');
  eq(noaCarried?.carried, true, 'על הלוח היא כבר "פעוטה"');
  eq(noaCarried?.own_classroom, 'צעירים', 'עם הכיתה החדשה');
  ok(!noaCarried?.pending_move, 'ובלי "מעבר ממתין"');

  const again2 = await request({ method: 'POST', path: `/api/children/move-requests/${reqId}/approve`, token: managerToken });
  eq(again2.status, 400, 'אישור כפול נדחה');

  /* ---------------------------------------------------------------- */
  head('8. דחייה');
  await Child.updateOne({ _id: dan._id }, { $set: { classroom_id: nursery._id } });
  const ask2 = await request({
    method: 'POST', path: '/api/nursery/board/move-request', token: ganToken,
    body: { classroom: room, child_id: String(dan._id), keep_on_board: false },
  });
  eq(ask2.status, 201, 'בקשה חדשה לדן');
  const rejected = await request({
    method: 'POST', path: `/api/children/move-requests/${ask2.body.request_id}/reject`, token: managerToken,
    body: { reason: 'עוד מוקדם' },
  });
  eq(rejected.status, 200, 'הדחייה התקבלה');
  eq(String((await Child.findById(dan._id)).classroom_id), String(nursery._id), 'דן נשאר במקום');
  eq((await ClassroomMoveRequest.findById(ask2.body.request_id).lean()).reject_reason, 'עוד מוקדם', 'עם הסיבה');

  /* ---------------------------------------------------------------- */
  head('9. גרירה בדשבורד — מעבר ישיר, ומנהלת הסניף מקבלת התראה כשמישהו אחר גרר');
  const stats = await request({ path: `/api/dashboard/stats?branch=${ks._id}`, token: managerToken });
  eq(stats.status, 200, 'הדשבורד נטען');
  ok(!!stats.body?.classroomIds?.['צעירים'], 'העמודות מכירות את מזהה הכיתה');
  const col = Object.values(stats.body?.classrooms || {}).flat().find(k => k.child_name === 'דן שגב');
  ok(!!col?.id && !!col?.classroom_id, 'לכל ילד מזהה + כיתה נוכחית לגרירה');

  const dragged = await request({
    method: 'PUT', path: `/api/children/${dan._id}/classroom`, token: adminToken,
    body: { classroom_id: String(toddlers._id) },
  });
  eq(dragged.status, 200, 'הגרירה התקבלה');
  eq(String((await Child.findById(dan._id)).classroom_id), String(toddlers._id), 'דן בצעירים');
  await sleep(300); // notifyMoved is fire-and-forget
  const moved = await NotificationEvent.find({ type: 'child_moved' }).lean();
  eq(moved.length, 1, 'נוצרה התראת "הועבר" אחת');
  eq(String(moved[0]?.recipient_id), String(manager._id), 'למנהלת הסניף, לא למי שגרר');
  ok(!!moved[0]?.resolved_at, 'וסגורה מיד — אין מה לאשר');

  const dragBack = await request({
    method: 'PUT', path: `/api/children/${noa._id}/classroom`, token: managerToken,
    body: { classroom_id: String(nursery._id) },
  });
  eq(dragBack.status, 200, 'גרירה חזרה לתינוקייה');
  const noaBack = await Child.findById(noa._id).lean();
  ok(!noaBack.board_extension?.classroom_id, 'ההרחבה נמחקה — היא שוב ילדת הכיתה');
  await sleep(300);
  eq((await NotificationEvent.find({ type: 'child_moved' }).lean()).length, 1, 'המנהלת היחידה גררה בעצמה — אף אחד לא מקבל התראה');

  const ganDrag = await request({
    method: 'PUT', path: `/api/children/${noa._id}/classroom`, token: ganToken,
    body: { classroom_id: String(toddlers._id) },
  });
  ok(ganDrag.status === 403 || ganDrag.status === 401, `גננת לא גוררת (${ganDrag.status})`);

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} בדיקות עברו`);
}

main()
  .catch((err) => { console.error('\n💥', err); failures++; })
  .finally(async () => {
    try { server?.close(); } catch { /* ignore */ }
    try { await mongoose.disconnect(); } catch { /* ignore */ }
    try { await mongod?.stop(); } catch { /* ignore */ }
    process.exit(failures ? 1 : 0);
  });
