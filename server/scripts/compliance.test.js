#!/usr/bin/env node
/**
 * תוקף — the status every screen, badge and mail derives from one date.
 *
 * Everything worth testing here is a boundary: the day itself, the edge of the
 * warning window, the row with no date, and the digest's "did anything
 * change" key that decides whether a mail goes out at all.
 *
 *   node scripts/compliance.test.js
 */

const { statusOf, daysLeft, WARN_DAYS } = require('../src/services/compliance');

let failures = 0;
const ok = (cond, label) => { console.log(`  ${cond ? '✅' : '❌'} ${label}`); if (!cond) failures++; };
const eq = (a, b, label) => {
  const good = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  ${good ? '✅' : '❌'} ${label}${good ? '' : `  (קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)})`}`);
  if (!good) failures++;
};

const NOW = new Date('2026-08-30T10:00:00');
const days = n => new Date(NOW.getTime() + n * 86400000);

console.log('\nstatusOf — the boundaries');
eq(statusOf(null, NOW), 'no_expiry', 'no date is its own state, not "fine"');
eq(statusOf('לא תאריך', NOW), 'no_expiry', 'unparsable text does not crash and does not pass as valid');
eq(statusOf(days(-1), NOW), 'expired', 'yesterday is expired');
eq(statusOf(NOW, NOW), 'expiring', 'the printed day itself is still valid — flagged, not expired');
eq(statusOf(new Date('2026-08-29T23:00:00'), NOW), 'expired', 'valid THROUGH the printed date: the next morning it is expired');
eq(statusOf(days(WARN_DAYS - 1), NOW), 'expiring', `inside the ${WARN_DAYS}-day window`);
eq(statusOf(days(WARN_DAYS + 2), NOW), 'ok', 'outside the window');
eq(statusOf(days(365), NOW), 'ok', 'a year out is ok');

console.log('\ndaysLeft — what the mail prints');
eq(daysLeft(days(5), NOW), 5, 'five days out');
ok(daysLeft(days(-3), NOW) < 0, 'negative once passed');
eq(daysLeft(null, NOW), null, 'no date, no number');

console.log('\nthe digest change key');
const { hashOf } = require('../src/services/complianceDigestJob');
const a = { dueCerts: [{ branch: 'הרצליה', type: 'רישיון הפעלה', status: 'expiring' }], dueCourses: [] };
const b = { dueCerts: [{ branch: 'הרצליה', type: 'רישיון הפעלה', status: 'expiring' }], dueCourses: [] };
const c = { dueCerts: [{ branch: 'הרצליה', type: 'רישיון הפעלה', status: 'expired' }], dueCourses: [] };
eq(hashOf(a), hashOf(b), 'same list, same key — no repeat mail');
ok(hashOf(a) !== hashOf(c), 'expiring→expired IS a change — the mail goes out again');
const d = { dueCerts: [], dueCourses: [{ employee: 'אתי', type: 'עזרה ראשונה (מד"א)', status: 'expired' }] };
ok(hashOf(a) !== hashOf(d), 'a course appearing is a change');

console.log(failures ? `\n${failures} בדיקות נכשלו` : '\nהכל עבר ✅');
process.exit(failures ? 1 : 0);
