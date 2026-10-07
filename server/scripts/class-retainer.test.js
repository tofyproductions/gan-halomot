#!/usr/bin/env node
/**
 * ריטיינר — a fixed monthly sum "for four meetings", and the year-end truth.
 *
 * The case is real: an instructor paid 2,940 a month for four Mondays. Some
 * months have three Mondays and some five, and the sum does not change. What
 * must hold:
 *
 *   the month's payment is the fee, whatever the calendar held;
 *   each meeting is worth fee / 4 = 735;
 *   the settlement counts what actually happened — partial at its fraction,
 *     no-show and postponed at nothing — against everything paid;
 *   a positive balance means she owes the gan a credit, a negative one means
 *     the gan owes her; the forecast sees it coming before the year ends;
 *   and without a start month the settlement refuses rather than guessing how
 *     many months were paid.
 *
 *   node scripts/class-retainer.test.js
 */
try { require.resolve('mongodb-memory-server'); } catch {
  console.error('\n❌  npm install --no-save mongodb-memory-server\n'); process.exit(1);
}
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = { id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) } };
const { MongoMemoryServer } = require('mongodb-memory-server');

let failures = 0;
const ok = (c, l, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${l}${!c && d ? `  (${d})` : ''}`); if (!c) failures++; };
const eq = (a, b, l) => ok(a === b, l, `קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)}`);

(async () => {
  const mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri() + 'gan_test';
  process.env.JWT_SECRET = 'retainer-test';
  delete process.env.PLATFORM_MONGODB_URI;
  const mongoose = require('mongoose');
  const jwt = require('jsonwebtoken');
  await mongoose.connect(process.env.MONGODB_URI);
  const { Branch, ClassProvider, ClassProgram, ClassSession } = require('../src/models');
  const R = require('../src/services/classRetainer.service');

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/classes', require('../src/routes/classes.routes'));
  app.use((err, req, res, _n) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/classes`;
  const tok = jwt.sign({ id: String(new mongoose.Types.ObjectId()), role: 'system_admin' }, process.env.JWT_SECRET);
  const call = async (m, p, b) => {
    const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, ...(b ? { body: JSON.stringify(b) } : {}) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  console.log('\n💰 ריטיינר חודשי\n');
  const hz = await Branch.create({ name: 'הרצליה הרצוג' });
  const made = await call('POST', '/providers', { name: 'מאיה בר שלום', field: 'מוזיקה', branch_ids: [String(hz._id)] });
  const id = made.body.provider._id;

  // No period yet: refuse.
  await call('PUT', `/providers/${id}`, { billing: { mode: 'monthly', monthly_fee: 2940, meetings_per_month: 4 } });
  let s = await call('GET', `/providers/${id}/settlement?as_of=2026-11`);
  eq(s.body.ok, false, 'בלי חודש התחלה — לא מנחשים כמה חודשים שולמו');
  eq(s.body.reason, 'no_period', 'ואומרים למה');

  await call('PUT', `/providers/${id}`, { billing: {
    mode: 'monthly', monthly_fee: 2940, meetings_per_month: 4, period_start: '2026-09', period_end: '2027-06',
  } });
  const sched = await call('PUT', `/providers/${id}/schedule`, { rows: [{
    branch_id: String(hz._id), classroom_categories: ['צעירים'], name: 'מוזיקה', instructor_name: 'מאיה',
    default_day: 1, default_time: '10:00', default_rate: 735,
  }] });
  const prog = sched.body.programs[0];

  // Sep 2026 has 4 Mondays (7,14,21,28); Nov 2026 has 5 (2,9,16,23,30).
  const mk = (date, status, extra = {}) => ClassSession.create({ program_id: prog._id, branch_id: hz._id, date, time: '10:00', rate: 735, status, ...extra });
  for (const d of ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']) await mk(d, 'occurred');
  // October: one no-show, one half lesson, two held — 2.5 meetings.
  await mk('2026-10-05', 'occurred'); await mk('2026-10-12', 'no_show');
  await mk('2026-10-19', 'partial', { partial_amount: 367.5 }); await mk('2026-10-26', 'occurred');
  // November: five Mondays, all held.
  for (const d of ['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30']) await mk(d, 'occurred');
  // December: still on the calendar.
  for (const d of ['2026-12-07', '2026-12-14', '2026-12-21', '2026-12-28']) await mk(d, 'scheduled');

  console.log('התשלום החודשי');
  const oct = await call('GET', '/payment-summary?month=2026-10');
  const p = oct.body.providers.find(x => x.provider_name === 'מאיה בר שלום');
  eq(p.subtotal, 2940, 'אוקטובר משולם 2,940 — למרות ש-2.5 מפגשים בלבד התקיימו');
  eq(p.retainer.held_this_month, 2.5, 'והמערכת יודעת שהיו 2.5 בפועל');
  eq(p.vat, 0, 'עוסק פטור — בלי מע״מ');
  const nov = await call('GET', '/payment-summary?month=2026-11');
  eq(nov.body.providers.find(x => x.provider_name === 'מאיה בר שלום').subtotal, 2940,
    'ונובמבר, עם חמישה ימי שני, גם הוא 2,940');
  const jul = await call('GET', '/payment-summary?month=2027-07');
  ok(!jul.body.providers.find(x => x.provider_name === 'מאיה בר שלום'),
    'ביולי, אחרי סוף ההסכם — לא משולם כלום');

  console.log('\nהמאזן עד היום');
  s = await call('GET', `/providers/${id}/settlement?as_of=2026-11`);
  eq(s.body.unit_value, 735, 'שווי מפגש = 2,940 / 4 = 735');
  eq(s.body.to_date.months_paid, 3, 'שולמו שלושה חודשים');
  eq(s.body.to_date.paid, 8820, 'סה״כ ששולם 8,820');
  eq(s.body.to_date.meetings_held, 11.5, 'התקיימו 11.5 מפגשים (4 + 2.5 + 5)');
  eq(s.body.to_date.meetings_paid_for, 12, 'מול 12 ששולם עליהם');
  eq(s.body.to_date.earned, 8452.5, 'שווי מה שהתקיים 8,452.5');
  eq(s.body.to_date.balance, 367.5, 'יתרה חיובית — היא חייבת לגן קיזוז של 367.5');

  console.log('\nתחזית לסוף השנה');
  eq(s.body.forecast.months, 10, 'ההסכם: ספטמבר עד יוני — 10 חודשים');
  eq(s.body.forecast.paid, 29400, 'סה״כ ישולם 29,400');
  eq(s.body.forecast.meetings, 15.5, 'מפגשים בלוח עד עכשיו: 11.5 שהתקיימו + 4 בדצמבר');
  ok(s.body.forecast.balance > 0, 'בלי מפגשים נוספים — הגן ישלם יותר משקיבל, וזה נראה כבר עכשיו');

  // The other direction: the gan owes her.
  for (const d of ['2027-01-04', '2027-01-11', '2027-01-18', '2027-01-25']) await mk(d, 'occurred');
  s = await call('GET', `/providers/${id}/settlement?as_of=2026-09`);
  eq(s.body.to_date.balance, 0, 'אחרי ספטמבר בלבד — 4 מפגשים, 2,940, מאוזן בדיוק');

  const B2 = await ClassProvider.create({ name: 'מרובה', billing: { mode: 'monthly', monthly_fee: 2940, meetings_per_month: 4, period_start: '2026-09' } });
  const g2 = await ClassProgram.create({ branch_id: hz._id, provider_id: B2._id, name: 'x', default_rate: 735 });
  for (const d of ['2026-09-01', '2026-09-08', '2026-09-15', '2026-09-22', '2026-09-29']) {
    await ClassSession.create({ program_id: g2._id, branch_id: hz._id, date: d, rate: 735, status: 'occurred' });
  }
  const s2 = await R.settlement(await ClassProvider.findById(B2._id).lean(), { asOf: '2026-09' });
  eq(s2.to_date.balance, -735, 'חמישה מפגשים בחודש של ארבעה — הגן חייב לה השלמה של 735');

  console.log('\nמפגש = ביקור, לא קבוצה');
  // Four groups on one morning are ONE meeting; a morning with one group of
  // the four is a quarter of one, and the group made up later adds its quarter.
  const B3 = await ClassProvider.create({ name: 'ארבע קבוצות', billing: { mode: 'monthly', monthly_fee: 2940, meetings_per_month: 4, period_start: '2026-09' } });
  const groups3 = [];
  for (const n of ['בוגרים', 'תינוקייה', 'צעירים א', 'צעירים ב']) {
    groups3.push(await ClassProgram.create({ branch_id: hz._id, provider_id: B3._id, name: n, default_rate: 735 }));
  }
  const visit = async (d, statuses) => {
    for (let i = 0; i < groups3.length; i++) {
      await ClassSession.create({ program_id: groups3[i]._id, branch_id: hz._id, date: d, rate: 735, status: statuses[i] });
    }
  };
  for (const d of ['2026-09-07', '2026-09-14', '2026-09-21']) await visit(d, ['occurred', 'occurred', 'occurred', 'occurred']);
  await visit('2026-09-28', ['occurred', 'no_show', 'postponed', 'no_show']);
  let s3 = await R.settlement(await ClassProvider.findById(B3._id).lean(), { asOf: '2026-09' });
  eq(s3.to_date.meetings_held, 3.25, '3 בקרים מלאים + בוקר עם קבוצה 1 מתוך 4 = 3.25 מפגשים (לא 13)');
  eq(s3.to_date.balance, 551.25, 'שולם 2,940 על 4, התקיימו 3.25 — היא חייבת קיזוז 551.25');
  await ClassSession.create({ program_id: groups3[2]._id, branch_id: hz._id, date: '2026-09-30', rate: 735, status: 'occurred' });
  s3 = await R.settlement(await ClassProvider.findById(B3._id).lean(), { asOf: '2026-09' });
  eq(s3.to_date.meetings_held, 3.5, 'הקבוצה שנדחתה הושלמה ביום אחר — עוד רבע');
  const sum3 = await call('GET', '/payment-summary?month=2026-09');
  const row3 = (sum3.body.providers || []).find(p => p.provider_name === 'ארבע קבוצות');
  eq(row3?.retainer?.held_this_month, 3.5, 'גם בסיכום החודשי: 3.5 מפגשים ולא 14');

  console.log(failures === 0 ? '\n✅  הכל עבר\n' : `\n❌  ${failures} נכשלו\n`);
  await mongoose.disconnect(); server.close(); await mongo.stop();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('\n💥', e); process.exit(1); });
