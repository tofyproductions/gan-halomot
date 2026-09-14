#!/usr/bin/env node
/**
 * Open the demo on the redesign, without rebuilding it.
 *
 * ganflow-demo-scramble.js now sets `ui_version` on every account it creates,
 * so a demo built from today onwards arrives correct. The demo that is serving
 * dreamgan.com right now was built before that, and rebuilding it to change two
 * boolean-shaped fields would mean re-cloning production into a hosted database
 * — the one window in this repository where real children's records sit on a
 * cluster reachable from the internet. That is a large risk to take for a
 * preference, so this does the small thing instead.
 *
 * WHY IT MATTERS. `User.ui_version` defaults to null, and null means: render
 * the classic shell, and offer the new one once. For the four gans running
 * their day on the old screens that is exactly right. For the demo it means a
 * prospect opens the product and sees the interface we are replacing, with a
 * dialog on top asking them to pick between two designs they have never seen.
 *
 * Dry run by default. It prints what it would change and writes nothing until
 * --yes is passed.
 *
 *   node scripts/ganflow-demo-ui-version.js --uri "mongodb+srv://.../ganflow_demo"
 *   node scripts/ganflow-demo-ui-version.js --uri "..." --yes
 *
 * The database name must contain "demo". This is the same guard the build
 * script uses, and it is here for the same reason: the connection string for
 * production differs from the demo's by a few characters, and this script's
 * whole job is an unconditional updateMany over `users`.
 */

const { MongoClient } = require('mongodb');

const argv = process.argv.slice(2);
const URI = argv.includes('--uri') ? argv[argv.indexOf('--uri') + 1] : null;
const WRITE = argv.includes('--yes');

function die(m) { console.error(`\n❌  ${m}\n`); process.exit(1); }

if (!URI) die('חסר --uri. צריך כתובת של מסד ההדגמה.');

const dbName = (URI.match(/\/([^/?]+)(\?|$)/) || [])[1];
if (!dbName) die('לא הצלחתי לקרוא שם מסד מהכתובת.');
if (!/demo/i.test(dbName)) {
  die(`שם המסד הוא "${dbName}" ואינו מכיל "demo". מסרב — זה עלול להיות מסד אמיתי.`);
}

(async () => {
  const client = new MongoClient(URI);
  await client.connect();
  const db = client.db();
  const users = db.collection('users');

  const total = await users.countDocuments({});
  const alreadyNew = await users.countDocuments({ ui_version: 'new' });
  const classic = await users.countDocuments({ ui_version: 'classic' });
  const unset = await users.countDocuments({
    $or: [{ ui_version: null }, { ui_version: { $exists: false } }],
  });
  const notAsked = await users.countDocuments({
    $or: [{ ui_version_asked: { $ne: true } }],
  });

  console.log(`\n─── מסד "${dbName}" ───`);
  console.log(`  סה"כ משתמשים            ${total}`);
  console.log(`  כבר על העיצוב החדש      ${alreadyNew}`);
  console.log(`  על העיצוב הקלאסי        ${classic}`);
  console.log(`  בלי בחירה (ברירת מחדל)  ${unset}`);
  console.log(`  שתוצג להם ההצעה         ${notAsked}`);

  if (!WRITE) {
    console.log(`\n\u{1F441}️   ריצה יבשה. לא נכתב כלום.`);
    console.log(`   להרצה אמיתית הוסף --yes\n`);
    await client.close();
    return;
  }

  const r = await users.updateMany({}, {
    $set: { ui_version: 'new', ui_version_asked: true },
  });

  console.log(`\n\u{1F3A8} ${r.modifiedCount} משתמשים עודכנו.`);

  const check = await users.countDocuments({ ui_version: 'new', ui_version_asked: true });
  if (check !== total) {
    die(`אחרי הכתיבה רק ${check} מתוך ${total} תקינים. בדוק ידנית.`);
  }
  console.log(`\u{2705} כל ${total} המשתמשים נפתחים בעיצוב החדש, בלי שאלה.\n`);

  await client.close();
})().catch((e) => die(e.message));
