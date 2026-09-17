/**
 * One person, two employee cards, one of them holding half her history.
 *
 * Two people were entered twice on the morning of 30.08.2026, each time with
 * the surname and the given name the other way round and the same ת"ז. Nothing
 * refuses that today, so the clock kept punching one card while the payslips
 * were filed against the other, and the screens that ask "did she get her
 * payslip" answered about whichever card they happened to be looking at.
 *
 * This moves every document that references the loser onto the keeper and then
 * retires the loser. It is not a general de-duplication tool and does not try
 * to be: it takes two ids that a person has already decided about, because
 * deciding which card survives is a payroll question — which one the clock
 * knows, which one the accountant has been paying — and not one a script can
 * answer from the data.
 *
 * DRY BY DEFAULT. Without `--write` it reads everything, prints exactly what it
 * would move, and writes nothing. The default is dry rather than the flag being
 * `--dry-run` for the same reason as import-nursery-history.js: a mistyped
 * MONGODB_URI should produce a printout, not an incident.
 *
 *   node scripts/merge-duplicate-employee.js --keep <id> --lose <id>
 *   node scripts/merge-duplicate-employee.js --keep <id> --lose <id> --write
 *   node scripts/merge-duplicate-employee.js --undo <manifest.json>
 *
 * Options:
 *   --keep <id>       the employee card that survives. Required.
 *   --lose <id>       the card whose references move away. Required.
 *   --write           actually write. Everything else is a dry run.
 *   --manifest <path> where to record what moved. Defaults to a timestamped
 *                     file beside this script. Written BEFORE the updates, so
 *                     an interrupted run is still reversible.
 *   --undo <path>     put everything in a manifest back where it came from.
 *   --expect-db <name>  refuse to run unless MONGODB_URI points at this
 *                     database. The last guard before a production write.
 *
 * WHAT IT REFUSES TO DECIDE. Where both cards hold a row that a unique index
 * says only one of them may have — `PayrollMonth` on (employee_id, month),
 * `SavedPayslip` on (employee_id, year_month) — the script does NOT pick. It
 * prints the pair and stops, unless `--resolve <collection>:<key>=keep|lose`
 * names a decision for that exact row. A payroll month is somebody's wages;
 * merging two of them by a rule like "newest wins" is how a month quietly
 * loses its hours.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
}
function args(name) {
  const out = [];
  process.argv.forEach((a, i) => { if (a === name) out.push(process.argv[i + 1]); });
  return out.filter(Boolean);
}

/**
 * Every collection that points at an employee, discovered from the schemas
 * rather than listed here.
 *
 * A hand-written list is a list that goes stale the first time somebody adds a
 * model, and the failure mode is silent: the merge reports success and leaves
 * rows behind pointing at a retired card.
 */
function referringModels(models) {
  const out = [];
  for (const [name, M] of Object.entries(models)) {
    if (!M || !M.schema || typeof M.countDocuments !== 'function') continue;
    for (const p of Object.keys(M.schema.paths)) {
      const t = M.schema.paths[p];
      const ref = t?.options?.ref || t?.caster?.options?.ref;
      if (ref === 'Employee') out.push({ name, M, path: p, many: !!t.caster });
    }
  }
  return out;
}

/** The unique indexes that make a move impossible, per collection. */
const GUARDED = {
  PayrollMonth: 'month',
  SavedPayslip: 'year_month',
  SavedPayslipVersion: 'year_month',
};

async function plan({ models, keep, lose }) {
  const refs = referringModels(models);
  const moves = [];
  const collisions = [];

  for (const { name, M, path: p, many } of refs) {
    const q = many ? { [p]: lose } : { [p]: lose };
    const rows = await M.find(q).lean();
    if (rows.length === 0) continue;

    const guard = GUARDED[name];
    if (guard) {
      // Which of these would land on a row the keeper already has.
      const keeperKeys = new Set(
        (await M.find({ [p]: keep }).select(guard).lean()).map(r => String(r[guard])),
      );
      for (const r of rows) {
        if (keeperKeys.has(String(r[guard]))) {
          collisions.push({ collection: name, key: String(r[guard]), loseId: String(r._id) });
        } else {
          moves.push({ collection: name, path: p, many, id: String(r._id), label: String(r[guard]) });
        }
      }
      continue;
    }
    for (const r of rows) moves.push({ collection: name, path: p, many, id: String(r._id), label: '' });
  }
  return { moves, collisions };
}

async function main() {
  const keep = arg('--keep');
  const lose = arg('--lose');
  const undoPath = arg('--undo');
  const write = process.argv.includes('--write');
  const expectDb = arg('--expect-db');

  if (!undoPath && (!keep || !lose)) {
    console.error('usage: node scripts/merge-duplicate-employee.js --keep <id> --lose <id> [--write]');
    console.error('       node scripts/merge-duplicate-employee.js --undo <manifest.json>');
    process.exit(1);
  }
  if (keep && keep === lose) { console.error('--keep and --lose are the same id'); process.exit(1); }

  await mongoose.connect(process.env.MONGODB_URI);
  const dbName = mongoose.connection.name;
  if (expectDb && dbName !== expectDb) {
    console.error(`refusing: MONGODB_URI points at "${dbName}", expected "${expectDb}"`);
    await mongoose.disconnect();
    process.exit(1);
  }
  const models = require('../src/models');

  if (undoPath) return undo({ models, undoPath, write });

  const [k, l] = await Promise.all([
    models.Employee.findById(keep).populate('branch_id', 'name').lean(),
    models.Employee.findById(lose).populate('branch_id', 'name').lean(),
  ]);
  if (!k) { console.error(`no employee ${keep}`); process.exit(1); }
  if (!l) { console.error(`no employee ${lose}`); process.exit(1); }
  if (k.israeli_id && l.israeli_id && k.israeli_id !== l.israeli_id) {
    console.error(`refusing: different ת"ז — ${k.israeli_id} vs ${l.israeli_id}. This is not the same person.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log(`\nמסד נתונים: ${dbName}`);
  console.log(`נשארת:  ${k.full_name}  (${k.israeli_id})  פעילה: ${k.is_active}  סניף: ${k.branch_id?.name || '-'}`);
  console.log(`נמחקת:  ${l.full_name}  (${l.israeli_id})  פעילה: ${l.is_active}  סניף: ${l.branch_id?.name || '-'}\n`);

  const { moves, collisions } = await plan({ models, keep, lose });

  const byCollection = moves.reduce((acc, m) => {
    (acc[m.collection] = acc[m.collection] || []).push(m); return acc;
  }, {});
  console.log('=== יעבור אל הכרטיס שנשאר ===');
  if (!moves.length) console.log('  (שום דבר)');
  for (const [c, rows] of Object.entries(byCollection)) {
    const labels = rows.map(r => r.label).filter(Boolean);
    console.log(`  ${c.padEnd(24)} ${String(rows.length).padStart(4)}${labels.length ? '   ' + labels.join(', ') : ''}`);
  }

  if (collisions.length) {
    console.log('\n=== ⚠️ התנגשויות — שתי הרשומות מחזיקות את אותו מפתח ===');
    for (const c of collisions) {
      const decided = args('--resolve').find(r => r.startsWith(`${c.collection}:${c.key}=`));
      console.log(`  ${c.collection} ${c.key}${decided ? `   → ${decided.split('=')[1]}` : '   → לא הוכרע'}`);
    }
    const undecided = collisions.filter(c =>
      !args('--resolve').some(r => r.startsWith(`${c.collection}:${c.key}=`)));
    if (undecided.length) {
      console.log('\nהריצה נעצרת. כל התנגשות היא נתון שכר של מישהי, ואין כלל אוטומטי');
      console.log('שנכון עבורה. להכריע במפורש, למשל:');
      console.log(`  --resolve ${undecided[0].collection}:${undecided[0].key}=keep\n`);
      await mongoose.disconnect();
      process.exit(2);
    }
  }

  if (!write) {
    console.log('\nהרצה יבשה. שום דבר לא נכתב. להוסיף --write אחרי קריאת הרשימה.\n');
    await mongoose.disconnect();
    return;
  }

  // The manifest is written BEFORE the updates on purpose: a run interrupted
  // halfway must still be reversible, and a manifest written afterwards is the
  // one thing an interrupted run would not have.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const manifest = arg('--manifest') || path.join(__dirname, `merge-${lose}-to-${keep}-${stamp}.json`);
  const resolutions = args('--resolve');
  fs.writeFileSync(manifest, JSON.stringify({
    db: dbName, keep, lose, at: new Date().toISOString(),
    keep_name: k.full_name, lose_name: l.full_name,
    moves, collisions, resolutions,
    lose_was_active: l.is_active,
  }, null, 1));
  console.log(`\nמניפסט: ${manifest}`);

  let moved = 0;
  for (const mv of moves) {
    await models[mv.collection].updateOne({ _id: mv.id }, { $set: { [mv.path]: keep } });
    moved += 1;
  }
  // A collision resolved as `lose` means the keeper's own row is the wrong one:
  // remove it, then move the loser's across into the space it left.
  for (const c of collisions) {
    const decision = (resolutions.find(r => r.startsWith(`${c.collection}:${c.key}=`)) || '').split('=')[1];
    const M = models[c.collection];
    const guard = GUARDED[c.collection];
    if (decision === 'lose') {
      await M.deleteOne({ employee_id: keep, [guard]: c.key });
      await M.updateOne({ _id: c.loseId }, { $set: { employee_id: keep } });
      moved += 1;
    } else {
      await M.deleteOne({ _id: c.loseId });
    }
  }

  await models.Employee.updateOne({ _id: lose }, { $set: { is_active: false } });
  console.log(`\nהועברו ${moved} רשומות. הכרטיס "${l.full_name}" כובה.\n`);
  await mongoose.disconnect();
}

async function undo({ models, undoPath, write }) {
  const man = JSON.parse(fs.readFileSync(undoPath, 'utf8'));
  console.log(`\nביטול: ${man.lose_name} → ${man.keep_name}, ${man.moves.length} רשומות`);
  if (!write) {
    console.log('הרצה יבשה. להוסיף --write.\n');
    await mongoose.disconnect();
    return;
  }
  for (const mv of man.moves) {
    await models[mv.collection].updateOne({ _id: mv.id }, { $set: { [mv.path]: man.lose } });
  }
  await models.Employee.updateOne({ _id: man.lose }, { $set: { is_active: man.lose_was_active } });
  console.log(`הוחזרו ${man.moves.length} רשומות.`);
  console.log('שים לב: רשומות שנמחקו בגלל התנגשות אינן חוזרות — הן לא נשמרו.\n');
  await mongoose.disconnect();
}

module.exports = { plan, referringModels, GUARDED };
if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
