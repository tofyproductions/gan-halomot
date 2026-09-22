#!/usr/bin/env node
/**
 * "16:05" is not a fact about a working day.
 *
 * The approval queue showed a pending report as a bare time, and whether that
 * time was an ordinary finish, a half hour short or an hour of overtime was a
 * question about the employee's contracted weekly schedule — which lived on a
 * different screen. So the report was approved against nothing, and a month
 * that came out short was discovered on the payslip.
 *
 * The queue now states the commitment beside the time. These are the rules it
 * follows, and most of them are about the days where there is NO target: a
 * Saturday, a declared day off, a חופש לסרוגין day whose weeks were never
 * recorded, and an employee nobody ever built a schedule for. Each of those
 * must say so. A screen that rendered any of them as 00:00–00:00, or as a
 * large red gap, would be worse than one that stayed quiet.
 *
 * The helper is client code with no imports of its own, so it is loaded here
 * by stripping the `export` keyword — the real file, not a copy, because a
 * copy would agree with itself forever.
 *
 *   node scripts/punch-commitment.test.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '../../client/src/components/attendance/punchApproval.js');
const code = fs.readFileSync(SRC, 'utf8').replace(/^export /gm, '');
const sandbox = {
  module: {}, exports: {}, console,
  Date, Array, String, Boolean, Object, Number, Math, RegExp, JSON, isNaN,
};
vm.createContext(sandbox);
vm.runInContext(
  `${code}\n;module.exports = { weekdayOfISO, hhmmToMinutes, commitmentForDate, punchDelta, formatDelta, deltaSeverity, COMMITMENT_NOTE };`,
  sandbox,
);
const {
  weekdayOfISO, hhmmToMinutes, commitmentForDate, punchDelta, formatDelta, deltaSeverity,
} = sandbox.module.exports;

let failures = 0;
const eq = (a, b, label) => {
  const good = a === b;
  console.log(`  ${good ? '✅' : '❌'} ${label}${good ? '' : `  (קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)})`}`);
  if (!good) failures++;
};
const near = (a, b, label) => eq(Math.round(a * 100) / 100, b, label);

/** A five-day week, 07:30–16:00, Friday short, Saturday absent from the array. */
const standard = {
  days: [
    { day: 0, is_off: false, start_hhmm: '07:30', end_hhmm: '16:00' },
    { day: 1, is_off: false, start_hhmm: '07:30', end_hhmm: '16:00' },
    { day: 2, is_off: false, start_hhmm: '07:30', end_hhmm: '16:00' },
    { day: 3, is_off: false, start_hhmm: '07:30', end_hhmm: '16:00' },
    { day: 4, is_off: true, start_hhmm: '', end_hhmm: '' },
    { day: 5, is_off: false, start_hhmm: '07:30', end_hhmm: '12:30' },
  ],
  is_alternating_off: false,
  alternating_day: null,
};

// 2026-09-20 is a Sunday, so the week that follows it is Sun..Sat in order.
console.log('\n— איזה יום בשבוע —');
eq(weekdayOfISO('2026-09-20'), 0, 'ראשון');
eq(weekdayOfISO('2026-09-24'), 4, 'חמישי');
eq(weekdayOfISO('2026-09-26'), 6, 'שבת');
eq(weekdayOfISO(''), null, 'תאריך ריק — אין תשובה');
eq(weekdayOfISO('לא תאריך'), null, 'זבל — אין תשובה, לא קריסה');

console.log('\n— שעה למספר —');
eq(hhmmToMinutes('07:30'), 450, '07:30');
eq(hhmmToMinutes('00:00'), 0, 'חצות היא אפס, לא "ריק"');
eq(hhmmToMinutes(''), null, 'ריק');
eq(hhmmToMinutes('25:00'), null, 'שעה שלא קיימת');
eq(hhmmToMinutes('7:5'), null, 'חצי שעה — נדחה, כדי שלא ייקרא כ-7:05');

console.log('\n— הימים שאין בהם מול מה להשוות —');
eq(commitmentForDate(null, '2026-09-21').kind, 'no_commitment', 'אין התחייבות כלל');
eq(commitmentForDate(standard, '2026-09-26').kind, 'weekend', 'שבת — גם כשיש התחייבות');
eq(commitmentForDate(null, '2026-09-26').kind, 'weekend', 'שבת קודמת ל"אין התחייבות"');
eq(commitmentForDate(standard, '2026-09-24').kind, 'off', 'חמישי מסומן כיום חופש');
eq(
  commitmentForDate({ ...standard, days: [{ day: 0, is_off: false, start_hhmm: '', end_hhmm: '' }] }, '2026-09-20').kind,
  'unset',
  'יום עבודה בלי שעות — לא "חופש"',
);
eq(
  commitmentForDate({ ...standard, is_alternating_off: true, alternating_day: 5 }, '2026-09-25').kind,
  'alternating',
  'שישי לסרוגין — לא ידוע אם השבוע עבדה',
);
eq(
  commitmentForDate({ ...standard, is_alternating_off: true, alternating_day: 5 }, '2026-09-21').kind,
  'window',
  'יום רגיל אצל מי שיש לה יום לסרוגין אחר',
);

console.log('\n— חלון ההתחייבות —');
const sunday = commitmentForDate(standard, '2026-09-20');
eq(sunday.kind, 'window', 'ראשון — יש חלון');
eq(sunday.start_hhmm, '07:30', 'שעת התחלה');
eq(sunday.end_hhmm, '16:00', 'שעת סיום');
near(sunday.hours, 8.5, 'שמונה וחצי שעות');
near(commitmentForDate(standard, '2026-09-25').hours, 5, 'שישי — חמש שעות');

console.log('\n— הפער בין הדיווח להתחייבות —');
const at = (iso) => ({ timestamp: iso, state: iso.includes('T07') || iso.includes('T08') ? 0 : 1 });
eq(punchDelta(sunday, { state: 1, timestamp: '2026-09-20T16:05:00' }).minutes, 5, 'יציאה 16:05 — חמש דקות אחרי');
eq(punchDelta(sunday, { state: 1, timestamp: '2026-09-20T13:30:00' }).minutes, -150, 'יציאה 13:30 — שעתיים וחצי מוקדם');
eq(punchDelta(sunday, { state: 0, timestamp: '2026-09-20T07:30:00' }).minutes, 0, 'כניסה בדיוק בזמן');
eq(punchDelta(sunday, { state: 0, timestamp: '2026-09-20T08:15:00' }).minutes, 45, 'כניסה מאוחרת נמדדת מול ההתחלה');
eq(punchDelta(sunday, { state: 0, timestamp: '2026-09-20T07:30:00' }).edge, 'start', 'כניסה מול קצה ההתחלה');
eq(punchDelta(sunday, { state: 1, timestamp: '2026-09-20T16:00:00' }).edge, 'end', 'יציאה מול קצה הסיום');
eq(punchDelta(commitmentForDate(standard, '2026-09-24'), { state: 1, timestamp: '2026-09-24T16:00:00' }), null,
  'יום חופש — אין מול מה למדוד, ולא מוצג אפס');
eq(punchDelta(null, { state: 1, timestamp: '2026-09-20T16:00:00' }), null, 'בלי חלון — אין פער');
eq(punchDelta(sunday, { state: 1, timestamp: 'שעה לא חוקית' }), null, 'חותמת זמן פגומה — אין פער, לא NaN');
eq(at('2026-09-20T07:30:00').state, 0, 'עזר הבדיקה עצמו שפוי');

console.log('\n— איך הפער נקרא —');
eq(formatDelta({ minutes: 0 }), 'בדיוק', 'אפס');
eq(formatDelta({ minutes: 12 }), '+12 דק׳', 'איחור קצר');
eq(formatDelta({ minutes: -40 }), '−40 דק׳', 'הקדמה — מינוס טיפוגרפי, לא מקף');
eq(formatDelta({ minutes: -150 }), '−2:30 ש׳', 'מעבר לשעה נקרא כשעות');
eq(formatDelta({ minutes: 120 }), '+2 ש׳', 'שעתיים עגולות');
eq(formatDelta(null), '', 'אין פער — אין טקסט');

console.log('\n— מה שווה צבע —');
eq(deltaSeverity({ minutes: 5 }), 'none', 'חמש דקות זה רעש של יום עבודה');
eq(deltaSeverity({ minutes: -14 }), 'none', 'רבע שעה פחות אחת — עדיין רעש');
eq(deltaSeverity({ minutes: 15 }), 'warn', 'רבע שעה — כבר מסומן');
eq(deltaSeverity({ minutes: -59 }), 'warn', 'כמעט שעה — כתום');
eq(deltaSeverity({ minutes: -60 }), 'alert', 'שעה — אדום');
eq(deltaSeverity({ minutes: 240 }), 'alert', 'ארבע שעות מעבר — אדום');
eq(deltaSeverity(null), 'none', 'אין פער — אין צבע');

console.log(failures === 0 ? '\n✅ הכול עבר\n' : `\n❌ ${failures} כשלונות\n`);
process.exit(failures === 0 ? 0 : 1);
