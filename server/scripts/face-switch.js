#!/usr/bin/env node
/**
 * The switch, and the one number that says whether it is alive.
 *
 * Face recognition ships OFF. It is turned on for the teachers' bootstrap week
 * in ONE branch, watched, and turned off again the moment it misbehaves — all
 * without a deploy, which is the whole reason the switch is a Setting and not
 * an environment variable.
 *
 * The status is not decoration. The failure this feature is most likely to
 * have is silence: the queue jams, or the models fail to load after a deploy,
 * and from the outside nothing at all happens. Photographs keep uploading, the
 * gallery keeps working, no error appears anywhere, and parents simply assume
 * their child was not photographed. Without a number that stops moving, that
 * goes unnoticed for weeks.
 *
 *   node scripts/face-switch.js            # מצב
 *   node scripts/face-switch.js --on
 *   node scripts/face-switch.js --off
 */
const mongoose = require('mongoose');
require('dotenv').config({ path: `${__dirname}/../.env` });

const ago = (d) => {
  if (!d) return 'מעולם';
  const mins = Math.round((Date.now() - new Date(d)) / 60000);
  if (mins < 60) return `לפני ${mins} דק׳`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `לפני ${hours} שע׳`;
  return `לפני ${Math.round(hours / 24)} ימים`;
};

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('חסר MONGODB_URI');
  await mongoose.connect(process.env.MONGODB_URI);

  const scanner = require('../src/services/face/scanner');
  const { Setting } = require('../src/models');

  if (process.argv.includes('--on') || process.argv.includes('--off')) {
    const on = process.argv.includes('--on');
    await Setting.updateOne(
      { key: scanner.ENABLED_KEY },
      { $set: { key: scanner.ENABLED_KEY, value: { on } } },
      { upsert: true },
    );
    console.log(`\nזיהוי פנים: ${on ? '🟢 דולק' : '⚪️ כבוי'}`);
    if (on) {
      console.log('הסריקה מתחילה תוך 20 שניות. המודלים (191MB) נמשכים בפעם');
      console.log('הראשונה שמגיעה תמונה — לא בעליית השרת.');
    }
  }

  const h = await scanner.health();
  console.log('\n=== מצב זיהוי הפנים ===\n');
  console.log(`  מתג             : ${h.enabled ? '🟢 דולק' : '⚪️ כבוי'}`);
  console.log(`  ממתינות לסריקה  : ${h.pending}`);
  console.log(`  נכשלו           : ${h.failed}`);
  console.log(`  סריקה אחרונה    : ${ago(h.last_scan_at)}`);
  if (h.last_scan_ms) console.log(`  זמן לתמונה      : ${(h.last_scan_ms / 1000).toFixed(1)} שנ׳`);
  if (h.last_error_at) console.log(`  שגיאה אחרונה    : ${ago(h.last_error_at)}`);

  // The judgement, not just the facts. A queue that has work and has not moved
  // in hours is the silent death this whole screen exists to catch.
  const stalledFor = h.last_scan_at
    ? (Date.now() - new Date(h.last_scan_at)) / 3600000
    : Infinity;
  console.log('');
  if (!h.enabled) console.log('  כבוי — לא אמור לקרות כלום.');
  else if (h.pending === 0) console.log('  ✅ אין עומס. הכל נסרק.');
  else if (stalledFor > 6) {
    console.log(`  🔴 ${h.pending} תמונות ממתינות ושום דבר לא נסרק ${ago(h.last_scan_at)}.`);
    console.log('     זה נראה תקוע. בדוק לוגים ואת קבצי המודל (face:models).');
  } else console.log(`  ⏳ ${h.pending} בתור, נסרקות.`);
  console.log('');
}

main()
  .then(async () => { await mongoose.disconnect(); process.exit(0); })
  .catch(async (e) => {
    console.error(`\n❌ ${e.message}\n`);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
