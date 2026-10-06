#!/usr/bin/env node
/**
 * Add a dish to the stored daily-board menu.
 *
 * The code's DEFAULT_MENU is a SEED, not a source of truth: readConfig writes
 * it once and never looks at it again (nursery.service.js), because quietly
 * re-adding a dish somebody deliberately removed is worse than being out of
 * date. So editing DEFAULT_MENU does nothing for a gan that has already opened
 * the board — the live list is a `Setting` document, and this is how you add to
 * it.
 *
 * Adds only. The dish is appended to the end of its category and nothing else
 * in the stored menu is touched, so a list the gan has curated keeps its order
 * and its omissions.
 *
 * The same thing is doable by hand in the UI — the gear in the daily board,
 * /nursery/settings, for a system_admin or a branch manager. This script exists
 * for the cases where that is not practical: several dishes at once, a gan
 * nobody is logged into, or a change that wants to be reviewed before it lands.
 *
 *   node scripts/nursery-menu-add-dish.js --meal lunch --category פחמימה --dish פתיתים
 *   node scripts/nursery-menu-add-dish.js --meal lunch --category פחמימה --dish פתיתים --apply
 *
 * Dry by default: prints the category before and after and writes nothing.
 * --apply writes. Re-running after a successful apply is a no-op.
 *
 * Note: the menu is shared by every branch (the settings screen says so). There
 * is no per-branch menu.
 */
require('dotenv').config();
const mongoose = require('mongoose');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
}
const APPLY = process.argv.includes('--apply');

async function main() {
  const meal = arg('meal');
  const category = arg('category');
  const dish = (arg('dish') || '').trim();

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI חסר');
  await mongoose.connect(uri);
  console.log(`מסד: ${mongoose.connection.host}/${mongoose.connection.name}\n`);

  const { Setting } = require('../src/models');
  const nursery = require('../src/services/nursery.service');

  const doc = await Setting.findOne({ key: nursery.MENU_KEY }).lean();
  const stored = doc && doc.value;

  if (!stored) {
    console.log(`אין עדיין מסמך "${nursery.MENU_KEY}" במסד.`);
    console.log('המשמעות: התפריט החי הוא עדיין DEFAULT_MENU מהקוד, והוא ייכתב למסד');
    console.log('בפעם הראשונה שמישהו יפתח את הלוח. אם הוספת את המנה ל-DEFAULT_MENU —');
    console.log('אין מה לעשות כאן, היא תיכנס מעצמה.');
    return;
  }

  const meals = Object.keys(stored);
  if (!meal || !category || !dish) {
    console.log('חסרים פרמטרים. --meal <ארוחה> --category <קטגוריה> --dish <מנה>\n');
    console.log('התפריט ששמור במסד כרגע:');
    for (const m of meals) {
      console.log(`\n  ${m}  (${stored[m].label || ''})`);
      for (const [cat, dishes] of Object.entries(stored[m].categories || {})) {
        console.log(`    ${cat}: ${(dishes || []).join(', ')}`);
      }
    }
    process.exitCode = 1;
    return;
  }

  if (!stored[meal]) {
    throw new Error(`אין ארוחה "${meal}". יש: ${meals.join(', ')}`);
  }
  const categories = stored[meal].categories || {};
  if (!categories[category]) {
    throw new Error(`אין קטגוריה "${category}" ב-${meal}. יש: ${Object.keys(categories).join(', ')}`);
  }

  const before = (categories[category] || []).map(String);
  if (before.includes(dish)) {
    console.log(`"${dish}" כבר נמצא ב-${meal}/${category}. אין מה לעשות.`);
    return;
  }

  // Mirrors saveMenu's caps in nursery.controller, so a script cannot write a
  // menu the editor would then refuse to save.
  if (dish.length > 40) throw new Error('שם המנה ארוך מ-40 תווים');
  if (before.length >= 60) throw new Error(`ב-${meal}/${category} כבר 60 מנות — המקסימום`);

  const after = [...before, dish];
  console.log(`${meal} / ${category}`);
  console.log(`  לפני:  ${before.join(', ')}`);
  console.log(`  אחרי:  ${after.join(', ')}\n`);

  if (!APPLY) {
    console.log('הרצה יבשה. שום דבר לא נכתב. להוספה בפועל: הוסיפו --apply');
    return;
  }

  const next = JSON.parse(JSON.stringify(stored));
  next[meal].categories[category] = after;
  await Setting.updateOne(
    { key: nursery.MENU_KEY },
    { $set: { key: nursery.MENU_KEY, value: next } },
    { upsert: true },
  );
  console.log(`✅ "${dish}" נוסף ל-${meal}/${category}.`);
  console.log('הלוח קורא את ההגדרה בכל טעינה — אין צורך בדיפלוי.');
}

main()
  .catch((err) => { console.error(`\n❌ ${err.message}`); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
