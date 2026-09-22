#!/usr/bin/env node
/**
 * Emoji do not survive the Apps Script relay.
 *
 * Hebrew is two bytes per character and arrives perfectly. An emoji is four —
 * a surrogate pair — and somewhere in the GAS round trip it comes back as a
 * row of replacement characters. A candidate's confirmation read
 * "קיבלנו את המועמדות שלך ??????" where a rainbow belonged: the first thing
 * that gan ever sent her, and it looked broken.
 *
 * The relay is a Google Apps Script nobody deploys from this repository, so
 * the fix available is to stop handing it what it mangles. These are the rules
 * that strip does follow, and the two it must NOT: it does not touch Hebrew,
 * and it does not leave the hole the picture sat in.
 *
 *   node scripts/email-astral.test.js
 */

const { withoutAstral } = require('../src/services/email.service');

let failures = 0;
const eq = (actual, expected, label) => {
  const good = actual === expected;
  console.log(`  ${good ? '✅' : '❌'} ${label}${good ? '' : `\n      קיבלנו ${JSON.stringify(actual)}\n      ציפינו  ${JSON.stringify(expected)}`}`);
  if (!good) failures++;
};

/** Built from code points so this file has no astral characters of its own —
 *  the very thing it is about would otherwise be sitting in the test. */
const RAINBOW = String.fromCodePoint(0x1F308);
const MEMO = String.fromCodePoint(0x1F4DD);
const BALLOON = String.fromCodePoint(0x1F388);
const STOP = String.fromCodePoint(0x1F6D1);
const WARN = '⚠️';
const STAR = '⭐';

console.log('\n— מה שנשבר יוצא —');
eq(withoutAstral(`קיבלנו את המועמדות שלך ${RAINBOW}`), 'קיבלנו את המועמדות שלך', 'אימוג׳י בסוף משפט, יחד עם הרווח שלפניו');
eq(withoutAstral(`${WARN} שליחת טבלת שכר נכשלה`), 'שליחת טבלת שכר נכשלה', 'סימן אזהרה בתחילת נושא');
eq(withoutAstral(`${STOP} סוכן הנוכחות מנותק`), 'סוכן הנוכחות מנותק', 'אימוג׳י בתחילת נושא');
eq(withoutAstral(`<h2>רישום עובד/ת חדש/ה ${MEMO}</h2>`), '<h2>רישום עובד/ת חדש/ה</h2>', 'בתוך תגית, בלי להשאיר רווח לפני הסוגר');
eq(withoutAstral(`<h2>פנייה חדשה מהורה ${BALLOON}</h2>`), '<h2>פנייה חדשה מהורה</h2>', 'בלון');
eq(withoutAstral(`שלום ${STAR} וגם ${RAINBOW} שלום`), 'שלום וגם שלום', 'שניים באמצע — לא נשאר רווח כפול');

console.log('\n— מה שלא נוגעים בו —');
eq(withoutAstral('שלום, קיבלנו את הפנייה שלכם'), 'שלום, קיבלנו את הפנייה שלכם', 'עברית נשארת כפי שהיא');
eq(withoutAstral('Hello, we got your application'), 'Hello, we got your application', 'אנגלית נשארת');
eq(withoutAstral('סה״כ: 1,250 ₪ (12.5%)'), 'סה״כ: 1,250 ₪ (12.5%)', 'שקל, פסיקים ואחוזים — לא אימוג׳י');
eq(withoutAstral('גרשיים ״ וגרש ׳ ומקף — נשארים'), 'גרשיים ״ וגרש ׳ ומקף — נשארים', 'פיסוק עברי ומקף ארוך');
eq(withoutAstral('<a href="https://x.co/a?b=1&c=2">קישור</a>'), '<a href="https://x.co/a?b=1&c=2">קישור</a>', 'כתובת עם פרמטרים');

console.log('\n— לא קורס על מה שאינו מחרוזת —');
eq(withoutAstral(''), '', 'מחרוזת ריקה');
eq(withoutAstral(null), null, 'null');
eq(withoutAstral(undefined), undefined, 'undefined');
eq(withoutAstral(42), 42, 'מספר');

console.log('\n— הזחה של HTML נשמרת —');
const html = '<div dir="rtl">\n  <p>שורה</p>\n  <p>שורה שנייה</p>\n</div>';
eq(withoutAstral(html), html, 'HTML בלי אימוג׳י חוזר בדיוק כפי שהוא');

console.log(failures === 0 ? '\n✅ הכול עבר\n' : `\n❌ ${failures} כשלונות\n`);
process.exit(failures === 0 ? 0 : 1);
