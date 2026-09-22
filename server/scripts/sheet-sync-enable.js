/**
 * Turn the sheet sync on, off, or read-only — without a deploy.
 *
 * The switch is a single `Setting` document, deliberately: this runs against a
 * board the staff are using right now, and the way to stop it has to be faster
 * than a push. That also means it is hand-edited in a database, which is why
 * this script exists rather than a note saying which keys to type.
 *
 * Dry by default. It prints what the Setting says now and what it would say,
 * and changes nothing until `--write`.
 *
 *   node scripts/sheet-sync-enable.js                      # show the current state
 *   node scripts/sheet-sync-enable.js --mode read --write  # sheet → us only
 *   node scripts/sheet-sync-enable.js --mode both --write  # both directions
 *   node scripts/sheet-sync-enable.js --mode off  --write  # stop everything
 *   node scripts/sheet-sync-enable.js --mode both --only "כפר סבא - משה דיין" --write
 *
 * `--only` narrows to one branch and leaves the others exactly as they were,
 * because the rollout this serves is per branch: one gan, watched for a day
 * and a clean night, then the next.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { Setting, Branch } = require('../src/models');

const KEY = 'nursery_sheet_sync';

/**
 * The two תינוקייה sheets, by the branch they belong to.
 *
 * Hard-coded because they are not configuration — they are two specific
 * documents owned by the gan, named in the design spec, and a typo in a sheet
 * id is a sync that reads somebody else's spreadsheet. A third sheet is a code
 * change and a review, which is the right weight for that decision.
 */
const SHEETS = [
  { branch: 'כפר סבא - משה דיין', sheet_id: '19t4MY0z4Y4UNLanpqlFz-E4HqolmG7wrIsQNDLKTOMw' },
  { branch: 'כפר סבא - קפלן', sheet_id: '1R5XL3-RC0UggFaLjjO2WcAd96ZTz9M4F7aLEEE6_8KQ' },
];

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
};
const has = (name) => process.argv.includes(name);

const MODES = { off: 'off', read: 'read', both: 'both' };

async function main() {
  const mode = arg('--mode');
  const only = arg('--only');
  const write = has('--write');

  if (mode && !MODES[mode]) {
    console.error(`--mode חייב להיות אחד מ: ${Object.keys(MODES).join(' | ')}`);
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  const host = String(mongoose.connection.host || '');
  console.log(`\nמסד נתונים: ${host}\n`);

  const current = (await Setting.findOne({ key: KEY }).lean())?.value || {};
  const branches = await Branch.find().select('name').lean();
  const byName = new Map(branches.map(b => [b.name, String(b._id)]));

  const show = (label, cfg) => {
    console.log(`${label}:`);
    console.log(`  מופעל: ${cfg.enabled ? 'כן' : 'לא'}   כתיבה (ראשי): ${cfg.write === false ? 'כבוי' : 'פתוח'}`);
    for (const b of cfg.branches || []) {
      const name = branches.find(x => String(x._id) === String(b.branch_id))?.name || String(b.branch_id);
      const m = cfg.write === false ? 'dry' : (b.write === true ? 'write' : 'dry');
      console.log(`  ${name}  —  ${m === 'write' ? 'קריאה + כתיבה' : 'קריאה בלבד'}`);
    }
    if (!(cfg.branches || []).length) console.log('  (אין סניפים מוגדרים)');
    console.log('');
  };

  show('מצב נוכחי', current);

  if (!mode) {
    console.log('לא נבחר --mode. שום דבר לא השתנה.\n');
    await mongoose.disconnect();
    return;
  }

  // Built from the CURRENT setting so `--only` genuinely leaves the others
  // alone, rather than quietly rewriting every branch to whatever this run
  // happened to be about.
  const existing = new Map((current.branches || []).map(b => [String(b.branch_id), { ...b }]));
  const missing = [];

  for (const s of SHEETS) {
    if (only && s.branch !== only) continue;
    const id = byName.get(s.branch);
    if (!id) { missing.push(s.branch); continue; }
    if (mode === MODES.off) { existing.delete(id); continue; }
    existing.set(id, { branch_id: id, sheet_id: s.sheet_id, write: mode === MODES.both });
  }

  if (missing.length) {
    console.error(`לא נמצאו סניפים בשם: ${missing.join(', ')}`);
    console.error('שמות הסניפים במסד:', branches.map(b => b.name).join(' | '));
    await mongoose.disconnect();
    process.exit(1);
  }

  const next = {
    // `off` clears the branch list AND the master switch, so a half-cleared
    // setting can never look like "on with nothing to do".
    enabled: mode !== MODES.off && existing.size > 0,
    write: mode === MODES.both,
    branches: [...existing.values()],
  };

  show('מצב מבוקש', next);

  if (!write) {
    console.log('הרצה יבשה. שום דבר לא נכתב. להוסיף --write.\n');
    await mongoose.disconnect();
    return;
  }

  await Setting.findOneAndUpdate({ key: KEY }, { key: KEY, value: next }, { upsert: true });
  console.log('נשמר. הסנכרון קורא את ההגדרה בכל סבב — אין צורך בדיפלוי.\n');
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
