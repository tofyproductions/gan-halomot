#!/usr/bin/env node
/**
 * מעקב חוגים — the arrangement, the visit, and the money.
 *
 * The spreadsheet this replaces counted a DATE. An instructor came to a gan on
 * a Tuesday, took the תינוקייה and the צעירים and skipped the בוגרים, and the
 * sheet paid her for the Tuesday — corrected afterwards by a hand-typed row
 * reading "תשלום בחוסר שיעור" with a negative number against it and no record
 * of what it was for. A whole class of error that is invisible until somebody
 * argues about an invoice four months later.
 *
 * So what is worth proving here is arithmetic, not screens:
 *
 *   one provider's whole arrangement saves in one call, and a group taken out
 *     of it stops running WITHOUT destroying the sessions already paid for;
 *   three groups on one morning are ONE question, not three;
 *   each group is settled on its own — one came, one came short, one did not;
 *   the month adds up per PROVIDER across groups and branches, the way the
 *     invoice does;
 *   a postponed session is worth nothing in the month it left and something in
 *     the month it moved to, so nobody is paid twice;
 *   VAT is added for a provider registered for it and for nobody else.
 *
 *   node scripts/class-tracking.test.js
 */
try { require.resolve('mongodb-memory-server'); } catch {
  console.error('\n❌  חסרה חבילת הבדיקה. הרץ:\n\n   npm install --no-save mongodb-memory-server\n');
  process.exit(1);
}

const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};

const { MongoMemoryServer } = require('mongodb-memory-server');

let failures = 0;
const ok = (cond, label, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${label}${!cond && detail ? `  (${detail})` : ''}`);
  if (!cond) failures++;
  return !!cond;
};
const eq = (a, b, label) => ok(a === b, label, `קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)}`);

(async () => {
  const mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri() + 'gan_test';
  process.env.JWT_SECRET = 'class-tracking-test';
  delete process.env.PLATFORM_MONGODB_URI;

  const mongoose = require('mongoose');
  const jwt = require('jsonwebtoken');
  await mongoose.connect(process.env.MONGODB_URI);

  const { Branch, Classroom, ClassProvider, ClassProgram, ClassSession } = require('../src/models');

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/classes', require('../src/routes/classes.routes'));
  app.use((err, req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/classes`;

  const admin = jwt.sign(
    { id: String(new mongoose.Types.ObjectId()), full_name: 'מנהלת', role: 'system_admin' },
    process.env.JWT_SECRET, { expiresIn: '1h' },
  );
  /**
   * The branch manager is the one the popup is for — she is in the building.
   * The admin sets things up and reads the money; she is never asked whether
   * an instructor walked in, because she cannot know.
   */
  // Signed once the branches exist — a branch manager's token carries the
  // branches she manages, and without them she is scoped to nothing.
  let callMgr;
  const callAs = (token) => async (method, path, body) => {
    const r = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const call = callAs(admin);

  // ------------------------------------------------------------------ setup
  const ks = await Branch.create({ name: 'כפר סבא - משה דיין' });
  const hz = await Branch.create({ name: 'הרצליה הרצוג' });
  for (const [b, cat] of [[ks, 'תינוקייה'], [ks, 'צעירים'], [ks, 'בוגרים'], [hz, 'צעירים']]) {
    await Classroom.create({ name: `${cat} ${b.name}`, branch_id: b._id, category: cat, academic_year: '2026-2027' });
  }

  callMgr = callAs(jwt.sign({
    id: String(new mongoose.Types.ObjectId()), full_name: 'מנהלת סניף',
    role: 'branch_manager', branch_id: String(ks._id),
    managed_branch_ids: [String(ks._id), String(hz._id)],
  }, process.env.JWT_SECRET, { expiresIn: '1h' }));

  console.log('\n🎪 מעקב חוגים\n');

  // ------------------------------------------------- the whole arrangement
  console.log('הגדרת ספק אחת — כל החוגים שלו');
  const made = await call('POST', '/providers', {
    name: 'אוריאן להב', field: 'מוזיקה ותנועה', phone: '0543385436',
    branch_ids: [String(ks._id), String(hz._id)], vat_mode: 'registered',
  });
  eq(made.status, 201, 'הספק נוצר');
  const providerId = made.body.provider._id;
  eq(made.body.provider.vat_mode, 'registered', 'ונשמר כעוסק מורשה');
  eq((made.body.provider.branch_ids || []).length, 2, 'ועם שני סניפים');

  // One instructor, one morning at משה דיין, three groups at two rates — and
  // a fourth group on another day at another branch.
  const rows = [
    { branch_id: String(ks._id), classroom_category: 'תינוקייה', name: 'תנועה', instructor_name: 'אוריאן', default_day: 2, default_time: '09:00', default_rate: 180 },
    { branch_id: String(ks._id), classroom_category: 'צעירים', name: 'תנועה', instructor_name: 'אוריאן', default_day: 2, default_time: '09:30', default_rate: 360 },
    { branch_id: String(ks._id), classroom_category: 'בוגרים', name: 'תנועה', instructor_name: 'אוריאן', default_day: 2, default_time: '10:00', default_rate: 360 },
    { branch_id: String(hz._id), classroom_category: 'צעירים', name: 'תנועה', instructor_name: 'אוריאן', default_day: 4, default_time: '09:00', default_rate: 300 },
  ];
  const sched = await call('PUT', `/providers/${providerId}/schedule`, { rows });
  eq(sched.status, 200, 'הלוח נשמר בקריאה אחת');
  eq((sched.body.programs || []).length, 4, 'ארבעה חוגים נוצרו');

  const ksPrograms = sched.body.programs.filter(p => String(p.branch_id) === String(ks._id));
  eq(ksPrograms.length, 3, 'שלושה מהם במשה דיין');
  ok(ksPrograms.every(p => p.default_day === 2), 'כולם ביום שלישי');
  const rates = ksPrograms.map(p => p.default_rate).sort((a, b) => a - b);
  ok(JSON.stringify(rates) === JSON.stringify([180, 360, 360]),
    'ותעריף שונה לתינוקייה', JSON.stringify(rates));

  // ---------------------------------------- several groups, one meeting
  console.log('\nקבוצות שיושבות יחד');
  // The four already exist — send them back WITH their ids, or the save
  // replaces them and every id captured above points at a switched-off class.
  const asRow = (p) => ({
    _id: p._id, branch_id: String(p.branch_id),
    classroom_categories: p.classroom_categories,
    name: p.name, instructor_name: p.instructor_name,
    default_day: p.default_day, default_time: p.default_time,
    default_rate: p.default_rate,
  });
  const combined = await call('PUT', `/providers/${providerId}/schedule`, {
    rows: [
      ...sched.body.programs.map(asRow),
      {
        branch_id: String(hz._id),
        classroom_categories: ['תינוקייה', 'צעירים'],
        name: 'תנועה', instructor_name: 'אוריאן',
        default_day: 1, default_time: '09:00', default_rate: 400,
      },
    ],
  });
  const both = combined.body.programs.find(p => (p.classroom_categories || []).length === 2);
  ok(Boolean(both), 'שורה אחת נושאת שתי קבוצות');
  eq(both.classroom_category, 'תינוקייה',
    'והשדה הישן נשאר הראשונה שבהן — מסכים ותיקים ממשיכים לעבוד');
  eq(both.default_rate, 400, 'תעריף אחד למפגש המשותף, לא אחד לכל קבוצה');

  await call('POST', '/sessions/generate', { program_id: both._id, dates: ['2026-10-05'] });
  const combinedSession = await ClassSession.findOne({ program_id: both._id });
  eq(combinedSession.rate, 400, 'והמפגש נושא את התעריף הזה פעם אחת');
  await ClassSession.deleteMany({ program_id: both._id });
  // Put the arrangement back to four rows, so what follows sees what it expects.
  await call('PUT', `/providers/${providerId}/schedule`, {
    rows: combined.body.programs
      .filter(p => (p.classroom_categories || []).length < 2)
      .map(asRow),
  });

  // ------------------------------------------------- filling a month
  console.log('\nמילוי חודש לפי היום הקבוע');
  const progById = Object.fromEntries(sched.body.programs.map(p => [p.classroom_category + '|' + p.branch_id, p]));
  // include_past, so the count is the month's arithmetic and not a function of
  // the day this test happens to run.
  const filled = await call('POST', '/sessions/fill-month', { month: '2026-10', include_past: true });
  eq(filled.status, 200, 'החודש מולא');
  // October 2026: Tuesdays 6,13,20,27 × 3 groups at משה דיין
  //              + Thursdays 1,8,15,22,29 × 1 group at הרצוג = 12 + 5
  eq(filled.body.created, 17, 'מספר המפגשים לפי הימים הקבועים');
  const again = await call('POST', '/sessions/fill-month', { month: '2026-10', include_past: true });
  eq(again.body.created, 0, 'לחיצה שנייה לא יוצרת כפילויות');
  eq(again.body.skipped, 17, 'וסופרת את מה שכבר קיים');

  // A month that is entirely behind us writes nothing by default — the popup
  // must never open on a week nobody was tracking.
  const past = await call('POST', '/sessions/fill-month', { month: '2020-01' });
  eq(past.body.created, 0, 'חודש שעבר לא ממולא מעצמו');
  const pastForced = await call('POST', '/sessions/fill-month', { month: '2020-01', include_past: true });
  ok(pastForced.body.created > 0, 'אלא אם ביקשו במפורש לשחזר אותו');
  await ClassSession.deleteMany({ date: { $regex: '^2020' } });

  const tuesdays = await ClassSession.find({
    program_id: progById['תינוקייה|' + String(ks._id)]._id, date: { $regex: '^2026-10' },
  }).sort({ date: 1 }).lean();
  ok(JSON.stringify(tuesdays.map(s => s.date)) ===
     JSON.stringify(['2026-10-06', '2026-10-13', '2026-10-20', '2026-10-27']),
    'וכולם נפלו על יום שלישי', JSON.stringify(tuesdays.map(s => s.date)));
  ok(tuesdays.every(s => s.time === '09:00' && s.rate === 180), 'עם השעה והתעריף של החוג');

  // Everything after this point is about ONE of those Tuesdays.
  console.log('\nיום שלישי אחד');
  const DAY = '2026-10-06';
  await ClassSession.deleteMany({ date: { $regex: '^2026-10' }, date: { $ne: DAY } });
  await ClassSession.deleteMany({ branch_id: hz._id });
  const due = await callMgr('GET', '/sessions/due');
  eq(due.status, 200, 'רשימת מה שצריך לענות עליו');
  eq((due.body.visits || []).length, 1, 'ביקור אחד — לא שלושה');
  const visit = due.body.visits[0];
  eq(visit.classes.length, 3, 'ובתוכו שלוש כיתות');
  eq(visit.provider_name, 'אוריאן להב', 'עם שם הספק');
  eq(visit.branch_name, 'כפר סבא - משה דיין', 'ושם הסניף');
  eq(visit.time, '09:00', 'והשעה היא של הכיתה הראשונה');
  ok((due.body.sessions || []).length === 3, 'והרשימה הישנה עדיין מוחזרת לדפדפן שלא רוענן');

  // ------------------------------------------------- one answer, three fates
  console.log('\nתשובה אחת, שלושה גורלות');
  const byCat = {};
  for (const c of visit.classes) {
    const s = await ClassSession.findById(c.id).populate('program_id', 'classroom_category').lean();
    byCat[s.program_id.classroom_category] = c.id;
  }
  const answered = await callMgr('POST', '/sessions/answer-visit', {
    answers: [
      { id: byCat['תינוקייה'], status: 'occurred' },
      { id: byCat['צעירים'], status: 'partial', partial_amount: 180, reason: 'חצי שיעור' },
      { id: byCat['בוגרים'], status: 'no_show', reason: 'לא הספיקה' },
    ],
  });
  eq(answered.status, 200, 'נשמר');
  eq(answered.body.saved, 3, 'שלושה מפגשים');
  const after = await ClassSession.find({ date: DAY }).lean();
  eq(after.filter(s => s.status === 'occurred').length, 1, 'אחד התקיים');
  eq(after.filter(s => s.status === 'partial').length, 1, 'אחד חלקית');
  eq(after.filter(s => s.status === 'no_show').length, 1, 'ואחד לא הגיע');
  ok(after.every(s => s.manager_confirmed === true), 'וכולם מאושרים בידי המנהלת');

  // -------------------------------- a make-up for ONE group, at its own hour
  console.log('\nהשלמה לקבוצה אחת');
  const missed = await ClassSession.findOne({ date: DAY, status: 'no_show' }).lean();
  await ClassSession.updateOne({ _id: missed._id }, { status: 'scheduled', manager_confirmed: false });
  const one = await callMgr('POST', '/sessions/answer-visit', {
    answers: [{
      id: String(missed._id), status: 'postponed', reason: 'המדריכה איחרה',
      new_date: '2026-10-08', new_time: '14:30',
    }],
  });
  eq(one.body.saved, 1, 'נשמר');
  const movedFrom = await ClassSession.findById(missed._id).lean();
  eq(movedFrom.status, 'postponed', 'המפגש המקורי מסומן כנדחה');
  eq(movedFrom.postponed_to_date, '2026-10-08', 'ומצביע על המועד החדש');
  const makeup = await ClassSession.findOne({ postponed_from_session_id: missed._id }).lean();
  ok(Boolean(makeup), 'נוצר מפגש השלמה');
  eq(makeup.time, '14:30',
    'בשעה שנבחרה — ולא בשעה המקורית, כי שיעור שמוזז נוחת איפה שהחדר פנוי');
  eq(makeup.rate, movedFrom.rate, 'ובאותו תעריף');
  eq(makeup.status, 'scheduled', 'והוא ממתין לתשובה — השאלה תחזור באותו יום');
  eq(await ClassSession.countDocuments({ date: DAY, status: 'postponed' }), 1,
    'ורק הקבוצה הזאת נדחתה — לא כל הביקור');
  // Put it back, so the month's arithmetic below is what it was.
  await ClassSession.deleteOne({ _id: makeup._id });
  await ClassSession.updateOne({ _id: missed._id },
    { status: 'no_show', manager_confirmed: true, postponed_to_date: null, postponed_to_session_id: null });

  const dueAgain = await callMgr('GET', '/sessions/due');
  eq((dueAgain.body.visits || []).length, 0, 'והביקור לא נשאל שוב');

  // ------------------------------------------- who is asked, and who is not
  console.log('\nמי בכלל נשאל');
  const forAdmin = await call('GET', '/sessions/due');
  eq(forAdmin.status, 200, 'מנהל מערכת מקבל תשובה');
  eq((forAdmin.body.visits || []).length, 0,
    'אבל אף ביקור — הוא לא בבניין ולא יכול לדעת');

  // ------------------------------------------------- the month
  console.log('\nהחודש');
  const sum = await call('GET', '/payment-summary?month=2026-10');
  eq(sum.status, 200, 'הסיכום נטען');
  eq(sum.body.providers.length, 1, 'ספק אחד');
  const p = sum.body.providers[0];
  eq(p.provider_name, 'אוריאן להב', 'מקובץ לפי ספק, לא לפי חוג');
  eq(p.programs.length, 3, 'ושלוש שורות פירוט מתחתיו');
  // 180 (התקיים) + 180 (חלקי) + 0 (לא הגיע)
  eq(p.subtotal, 360, 'לפני מע״מ — רק מה שהתקיים');
  eq(p.vat, 64.8, 'מע״מ 18% כי היא עוסק מורשה');
  eq(p.total, 424.8, 'וזה מה שיוצא מהבנק');

  // ------------------------------------------------- a postponed lesson
  console.log('\nשיעור שנדחה — לא משלמים פעמיים');
  const NOV = '2026-11-03';
  const tinok = progById['תינוקייה|' + String(ks._id)];
  await call('POST', '/sessions/generate', { program_id: tinok._id, dates: [NOV] });
  const novSession = await ClassSession.findOne({ program_id: tinok._id, date: NOV });
  await call('POST', `/sessions/${novSession._id}/answer`, {
    status: 'postponed', new_date: '2026-11-10', reason: 'חג',
  });
  const nov = await call('GET', '/payment-summary?month=2026-11');
  eq(nov.body.grand_subtotal, 0, 'בנובמבר עוד לא שולם כלום — המפגש רק נדחה');
  const replacement = await ClassSession.findOne({ date: '2026-11-10' });
  ok(Boolean(replacement), 'ונוצר מפגש חלופי');
  await call('POST', `/sessions/${replacement._id}/answer`, { status: 'occurred' });
  const nov2 = await call('GET', '/payment-summary?month=2026-11');
  eq(nov2.body.grand_subtotal, 180, 'ואחרי שהתקיים — משלמים פעם אחת בלבד');

  // ------------------------------------------------- exempt provider
  console.log('\nעוסק פטור');
  const ex = await call('POST', '/providers', { name: 'ליטף', field: 'חוג חיות', vat_mode: 'exempt' });
  const exSched = await call('PUT', `/providers/${ex.body.provider._id}/schedule`, {
    rows: [{ branch_id: String(ks._id), classroom_category: 'תינוקייה', name: 'חוג חיות', instructor_name: 'מור', default_day: 3, default_time: '09:00', default_rate: 180 }],
  });
  await call('POST', '/sessions/generate', { program_id: exSched.body.programs[0]._id, dates: ['2026-10-07'] });
  const exSession = await ClassSession.findOne({ date: '2026-10-07' });
  await call('POST', `/sessions/${exSession._id}/answer`, { status: 'occurred' });
  const sum2 = await call('GET', '/payment-summary?month=2026-10');
  const exRow = sum2.body.providers.find(x => x.provider_name === 'ליטף');
  eq(exRow.subtotal, 180, 'סכום לפני מע״מ');
  eq(exRow.vat, 0, 'ואין מע״מ לעוסק פטור');
  eq(exRow.total, 180, 'התעריף הוא החשבונית');

  // ------------------------------------------------- taking a group out
  console.log('\nמורידים קבוצה מהלוח');
  const keep = rows.filter(r => r.classroom_category !== 'בוגרים').map(r => {
    const match = sched.body.programs.find(p =>
      String(p.branch_id) === r.branch_id && p.classroom_category === r.classroom_category);
    return { ...r, _id: match._id };
  });
  const reSaved = await call('PUT', `/providers/${providerId}/schedule`, { rows: keep });
  eq(reSaved.body.programs.length, 3, 'נשארו שלושה חוגים');
  const dropped = await ClassProgram.findOne({
    provider_id: providerId, classroom_category: 'בוגרים', branch_id: ks._id,
  }).lean();
  eq(dropped.is_active, false, 'והחוג שהוסר כובה ולא נמחק');
  const stillThere = await ClassSession.countDocuments({ program_id: dropped._id });
  ok(stillThere > 0, 'והמפגשים שלו נשארו — החודש שכבר שולם לא משתנה');

  const sum3 = await call('GET', '/payment-summary?month=2026-10');
  const p3 = sum3.body.providers.find(x => x.provider_name === 'אוריאן להב');
  eq(p3.subtotal, 360, 'והסכום של אוקטובר נשאר כפי שהיה');

  console.log(failures === 0 ? `\n✅  הכל עבר\n` : `\n❌  ${failures} נכשלו\n`);
  await mongoose.disconnect();
  server.close();
  await mongo.stop();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('\n💥', e); process.exit(1); });
