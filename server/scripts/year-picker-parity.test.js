#!/usr/bin/env node
/**
 * Two shells ship. The year is one of the two facts every screen is about.
 * Both shells must let a person change it.
 *
 * `useAcademicYear` became a context precisely so the year would stop being a
 * per-screen setting — WHICH GAN and WHICH YEAR sit together, above everything
 * they qualify. The rail got the picker. The classic top bar, which is what
 * most people are actually looking at, never did: it has the branch selector
 * and nothing beside it, so on that interface the year is whatever localStorage
 * last held and there is no way to move it.
 *
 * That is worse than it sounds. The screens still READ the context, so a
 * classic user is looking at a specific year — they just cannot see which one
 * or change it. גבייה, ארכיון, גאנט, חופשות, סניפים and מחירון all answer for
 * a year nobody on that interface chose.
 *
 * `vite build` cannot see a missing control, so this reads both shells and
 * requires the same three things of each: the context, a bound picker, and the
 * off-year marker — the picker is only safe if leaving it set is impossible to
 * miss.
 *
 * It also guards the exception: the intake screens work on the year families
 * are being enrolled INTO, which is a rule that moves on 1 February by itself.
 * A picker there would let somebody file a child into last year by leaving a
 * dropdown where it was.
 *
 *   node scripts/year-picker-parity.test.js
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'client', 'src');
const SHELLS = {
  'הסרגל החדש': path.join(SRC, 'components', 'layout', 'Sidebar.jsx'),
  'הסרגל הישן': path.join(SRC, 'components', 'layout', 'classic', 'ClassicHeader.jsx'),
};
const INTAKE = {
  'רישום חיצוני': path.join(SRC, 'components', 'registration', 'TmtReconcile.jsx'),
  'רישום לאמונה': path.join(SRC, 'components', 'registration', 'EmunahEnrollment.jsx'),
};

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (cond) console.log(`  ✅ ${label}`);
  else { failures++; console.log(`  ❌ ${label}${detail ? `\n     ${detail}` : ''}`); }
};

const read = p => fs.readFileSync(p, 'utf8');

console.log('\n📅 בורר שנת הלימודים — בשני הממשקים\n');

for (const [name, file] of Object.entries(SHELLS)) {
  console.log(name);
  const s = read(file);

  ok(/useAcademicYear\s*\(\s*\)/.test(s),
    'קורא את ההקשר המשותף של השנה');
  ok(/selectedYear/.test(s) && /setSelectedYear/.test(s),
    'קורא את השנה הנבחרת ויודע לשנות אותה');
  ok(/value=\{selectedYear\}/.test(s),
    'יש בורר שהערך שלו הוא השנה הנבחרת');
  ok(/onChange=\{\(e\)\s*=>\s*setSelectedYear\(e\.target\.value\)\}/.test(s),
    'ושינוי בו כותב חזרה להקשר — לא ל-state מקומי');
  ok(/years\.previous/.test(s) && /years\.current/.test(s) && /years\.next/.test(s),
    'שלוש השנים מוצעות: הקודמת, הנוכחית והבאה');

  // The marker is the entire safety argument for a global year: one picker is
  // only safer than six if a year left on the wrong setting announces itself.
  ok(/isCurrentYear/.test(s),
    'שנה שאינה הנוכחית מסומנת ויזואלית');

  // formatAcademicYear puts the Hebrew year beside the Gregorian range. Showing
  // "2025-2026" alone asks every person in the gan to translate it themselves.
  ok(/formatAcademicYear/.test(s),
    'השנה מוצגת גם בעברית וגם בלועזית');
  console.log('');
}

console.log('מסכי הרישום — דווקא בלי בורר');
for (const [name, file] of Object.entries(INTAKE)) {
  const s = read(file);
  ok(!/useAcademicYear\s*\(\s*\)/.test(s) && !/value=\{selectedYear\}/.test(s),
    `${name} עובד על שנת ההרשמה בלבד, ואין בו בורר`);
  ok(/getEnrollmentYear/.test(s),
    `${name} שואב את השנה מהכלל, לא מהעדפה`);
}

console.log(`\n${failures === 0 ? '✅ הכול עבר' : `❌ ${failures} נכשלו`}\n`);
process.exit(failures === 0 ? 0 : 1);
