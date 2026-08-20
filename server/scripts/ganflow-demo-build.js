#!/usr/bin/env node
/**
 * Build a demo database in ONE command: clone production, then scramble it.
 *
 * WHY THIS EXISTS RATHER THAN RUNNING THE TWO SCRIPTS BY HAND:
 * between the clone finishing and the scrambler starting, the target database
 * holds every real child, telephone number and medical note in the gan. When
 * the target is a laptop that is a small window. When the target is a hosted
 * cluster reachable from the internet — which is the whole point of publishing
 * a demo — that window is the largest privacy risk in this repository, and it
 * lasts exactly as long as somebody's attention. Doing both in one process
 * closes it: the only way to stop halfway is to kill the command, and the
 * failure path below says plainly what is sitting in the target if you do.
 *
 * Usage:
 *   node scripts/ganflow-demo-build.js --to "mongodb+srv://.../ganflow_demo"
 *   ... --scramble-money      # also shift every shekel figure
 *
 * Reads MONGODB_URI from the server .env and never writes to it.
 */

const { execFileSync } = require('child_process');
const path = require('path');
require('dotenv').config();

const argv = process.argv.slice(2);
const TO = argv.includes('--to') ? argv[argv.indexOf('--to') + 1] : null;
const MONEY = argv.includes('--scramble-money');

function die(m) { console.error(`\n❌  ${m}\n`); process.exit(1); }

if (!TO) die('חסר --to. צריך כתובת של מסד ההדגמה.');
if (!process.env.MONGODB_URI) die('חסר MONGODB_URI בסביבה (קובץ .env של השרת).');
if (TO.trim() === process.env.MONGODB_URI.trim()) die('היעד זהה למקור. זה המסד האמיתי.');

const targetDb = (TO.match(/\/([^/?]+)(\?|$)/) || [])[1];
if (!targetDb) die('לא הצלחתי לקרוא שם מסד מכתובת היעד.');
if (!/demo/i.test(targetDb)) die(`שם מסד היעד הוא "${targetDb}" ואינו מכיל "demo". מסרב.`);

const here = (f) => path.join(__dirname, f);
const run = (file, args) => execFileSync(process.execPath, [here(file), ...args], { stdio: 'inherit' });

console.log(`\n\u{1F3D7}️   בונה מסד הדגמה ב-"${targetDb}"\n`);

try {
  run('ganflow-demo-clone.js', ['--to', TO, '--wipe']);
} catch {
  die('השכפול נכשל. מסד היעד ריק או חלקי — אל תשתמש בו.');
}

console.log('\n\u{26A0}️   היעד מחזיק כרגע נתונים אמיתיים. מערבל מיד.\n');

try {
  run('ganflow-demo-scramble.js', ['--uri', TO, '--yes', ...(MONEY ? ['--scramble-money'] : [])]);
} catch {
  console.error(
    '\n\u{1F6A8}  הערבול נכשל, והשכפול כבר רץ.\n' +
    `   מסד "${targetDb}" מחזיק ברגע זה נתונים אמיתיים של ילדים.\n` +
    '   אל תפרסם אותו. הרץ שוב, או מחק את המסד.\n'
  );
  process.exit(1);
}

console.log('\n\u{2705}  מסד ההדגמה מוכן.\n');
console.log('   לפני שמראים אותו למישהו — ודא שהשרת שמצביע אליו מוגדר עם:');
console.log('     DISABLE_JOBS=1     אחרת הוא יסרוק תיבות דואר, יסנכרן גיליונות ויוציא כסף על AI');
console.log('     MONGODB_URI        חייב להיות כתובת ההדגמה, לא של הייצור\n');
