#!/usr/bin/env node
/**
 * How often does it stay silent? — the report the teachers' week exists for.
 *
 * Everything measured before shipping says the system is RIGHT when it speaks:
 * zero mistakes across 648 pairs that are certainly different children. None of
 * it says how often it says nothing about a child who is plainly there. That
 * number cannot be invented, estimated from the sample, or reasoned out. It
 * needs faces a person labelled.
 *
 * WHY THE SAMPLE CANNOT ANSWER THIS. The obvious shortcut is to cluster the
 * 200 test photographs and score against the clusters. It was tried, and it
 * reports 99.4% — which is a tautology, not a finding: single-link clustering
 * at 0.55 puts a face in a group precisely because it sits within 0.55 of
 * another member, so holding it out and asking whether 0.55 finds it again can
 * only say yes. Labels have to come from outside the thing being measured,
 * which means from a teacher.
 *
 * So this reads the faces staff have named in the tagging queue and holds each
 * one out: it rebuilds that child's references from their OTHER faces and asks
 * what the system would have said having never seen this one.
 *
 *   node scripts/face-recall.js                 # whole gan
 *   node scripts/face-recall.js --branch <id>   # one branch
 *   node scripts/face-recall.js --since 2026-09-01
 */
const mongoose = require('mongoose');
require('dotenv').config({ path: `${__dirname}/../.env` });

const { evaluate, describe } = require('../src/services/face/recall');
const { MATCH_THRESHOLD } = require('../src/services/face/constants');

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};

// Enough labelled faces that a percentage means something. Below this the
// report prints the count and refuses to put a number next to it — a recall
// of "80%" from five faces is four faces and a rounding error.
const MIN_FACES = 60;

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('חסר MONGODB_URI');
  await mongoose.connect(uri);

  const { Photo, Child } = require('../src/models');

  const match = {
    source: 'staff',
    face_scan_status: 'done',
    'faces.decided_by': 'staff',
  };
  const branch = arg('branch');
  if (branch) match.branch_id = new mongoose.Types.ObjectId(branch);
  const since = arg('since');
  if (since) match.date = { $gte: since };

  const rows = await Photo.aggregate([
    { $match: match },
    { $unwind: '$faces' },
    // Only faces a PERSON named, and only while their numbers are still around
    // to be compared. Anything the scanner decided is not ground truth — it is
    // the thing being scored.
    {
      $match: {
        'faces.decided_by': 'staff',
        'faces.child_id': { $ne: null },
        'faces.embedding': { $exists: true },
      },
    },
    {
      $project: {
        child: '$faces.child_id',
        embedding: '$faces.embedding',
        // The candidate field in production is the room on the day, so the
        // score has to be narrowed the same way or it measures a harder
        // problem than the one that was built.
        group: { $concat: [{ $toString: '$classroom_id' }, ':', '$date'] },
        at: '$date',
      },
    },
  ]);

  console.log(`\n=== כמה המערכת מפספסת — דוח ===\n`);
  console.log(`סף ההתאמה הנמדד: ${MATCH_THRESHOLD}`);
  if (branch) console.log(`סניף: ${branch}`);
  if (since) console.log(`מתאריך: ${since}`);
  console.log('');

  if (rows.length < MIN_FACES) {
    console.log(`נמצאו ${rows.length} פרצופים שתויגו בידי אדם.`);
    console.log(`\n⚠️  זה מעט מדי כדי לומר אחוז. צריך לפחות ${MIN_FACES}.`);
    console.log('   אחוז מתוך מדגם קטן הוא שתי תמונות ועיגול, לא מדידה.');
    console.log('   הריצו את זה שוב אחרי שבוע התיוג.');
    return;
  }

  const result = evaluate(rows.map((r) => ({
    child: r.child, embedding: r.embedding, group: r.group, at: r.at,
  })));

  describe(result).forEach((l) => console.log(l));

  // Per-child, worst first: a single child the system never finds is a family
  // with an empty gallery, and it disappears inside a good average.
  const struggling = result.perChild
    .filter((c) => c.total >= 3 && c.matched / c.total < 0.8)
    .slice(0, 10);

  if (struggling.length) {
    const names = await Child.find({ _id: { $in: struggling.map((c) => c.child) } })
      .select('child_name').lean();
    const byId = new Map(names.map((n) => [String(n._id), n.child_name]));
    console.log('\nילדים שהמערכת מתקשה בהם:');
    struggling.forEach((c) => {
      console.log(`  ${(byId.get(c.child) || c.child).padEnd(20)} `
        + `${c.matched}/${c.total} זוהו`);
    });
    console.log('\n  שווה לבדוק אם יש להם מספיק תמונות ייחוס עדכניות.');
  }

  if (result.wrong > 0) {
    console.log('\n🔴 יש זיהויים שגויים. זה המספר שחייב להיות אפס —');
    console.log('   הורה שרואה ילד אחר מסומן כשלו הוא משבר אמון.');
    console.log(`   שקלו להעלות את MATCH_THRESHOLD מעל ${MATCH_THRESHOLD}.`);
  }
}

main()
  .then(async () => { await mongoose.disconnect(); process.exit(0); })
  .catch(async (e) => {
    console.error('נפל:', e.message);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
