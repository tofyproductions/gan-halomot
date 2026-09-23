/**
 * "3 תמונות חדשות של דני" — התזמון והחלון.
 *
 * Two rules carry this, and both are the kind that fail silently.
 *
 * THE WINDOW. The digest counts photographs added since the LAST DIGEST, not
 * photographs "from today". A teacher who uploads the morning's pictures at
 * nine in the evening would otherwise have them counted against a day whose
 * message already went out, and they would never be mentioned at all — the
 * family simply never hears about them.
 *
 * THE CEILING. Exactly one message a day. A hundred photographs across four
 * branches is a notification every few minutes; within a week parents switch
 * notifications off, and when they do they switch off the ones about payments
 * and pickup with them.
 */
const assert = require('assert');
const job = require('../src/services/photoDigestJob');

const failures = [];
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) {
    failures.push(`${name}: ${e.message}`); console.log(`  FAIL ${name} — ${e.message}`);
  }
};

console.log('photo digest:');

check('יומי נשלח בשעה שנקבעה בלבד', () => {
  assert.ok(job.isDue('daily', { hour: job.DAILY_HOUR, day: 2 }));
  assert.ok(!job.isDue('daily', { hour: job.DAILY_HOUR - 1, day: 2 }));
  assert.ok(!job.isDue('daily', { hour: job.DAILY_HOUR + 1, day: 2 }));
});

check('שבועי — רק בשישי, ורק בשעה הנכונה', () => {
  assert.ok(job.isDue('weekly', { hour: job.WEEKLY_HOUR, day: job.WEEKLY_DAY }));
  assert.ok(!job.isDue('weekly', { hour: job.WEEKLY_HOUR, day: 4 }), 'חמישי אינו שישי');
  assert.ok(!job.isDue('weekly', { hour: job.WEEKLY_HOUR + 2, day: job.WEEKLY_DAY }));
});

check('שבועי אינו נשלח בשעה של היומי', () => {
  assert.ok(!job.isDue('weekly', { hour: job.DAILY_HOUR, day: 3 }));
});

check('החלון הוא "מאז ההתראה הקודמת", לא "היום"', () => {
  // העלאה של 21:00 אתמול חייבת להיספר מחר. אם החלון היה "היום" היא הייתה
  // נופלת בין הכיסאות ולא הייתה מוזכרת לעולם.
  const lastNight = new Date('2026-09-22T18:00:00Z');
  const from = job.since({ photo_digest: { last_sent_at: lastNight } }, 'daily');
  assert.strictEqual(from.getTime(), lastNight.getTime());
});

check('הורה חדש מקבל חלון קצר, לא את כל ההיסטוריה', () => {
  const from = job.since({}, 'daily');
  const hours = (Date.now() - from.getTime()) / 3600000;
  assert.ok(hours > 23 && hours < 25, `${hours} שעות`);
  // "412 תמונות חדשות" בהודעה ראשונה זה לא ברוך הבא, זה קיר.
  const weekly = job.since({}, 'weekly');
  const days = (Date.now() - weekly.getTime()) / 86400000;
  assert.ok(days > 6.9 && days < 7.1, `${days} ימים`);
});

check('השעה נקראת לפי שעון ישראל, לא לפי השרת', () => {
  // Render יושב בפרנקפורט; חצות בישראל היא 23:00 שם, ובלי אזור זמן מפורש
  // ההתראה היומית הייתה יוצאת בשעה הלא נכונה חצי שנה בשנה.
  const noonIsrael = new Date('2026-09-23T09:00:00Z');   // 12:00 בישראל
  const { hour, day } = job.localNow(noonIsrael);
  assert.strictEqual(hour, 12, `קיבלנו ${hour}`);
  assert.strictEqual(day, 3, 'רביעי');
});

check('שישי מזוהה נכון', () => {
  const friday = new Date('2026-09-25T10:00:00Z');   // 13:00 בישראל, שישי
  const { hour, day } = job.localNow(friday);
  assert.strictEqual(day, job.WEEKLY_DAY, `קיבלנו יום ${day}`);
  assert.strictEqual(hour, job.WEEKLY_HOUR);
  assert.ok(job.isDue('weekly', { hour, day }), 'ההתראה השבועית אמורה לצאת עכשיו');
});

if (failures.length) {
  console.error(`\nFAIL face-digest — ${failures.length} שגויים`);
  failures.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}
console.log('\nPASS face-digest');
