#!/usr/bin/env node
/**
 * Can this branch's parents actually get in, and who already has?
 *
 * The same question the מעקב הורים רשומים screen answers, asked from a
 * terminal — and asked through the SAME service
 * (services/parentSignups.service), deliberately. There were two copies of
 * this logic for about an hour and that was already one too many: a screen
 * and a report that disagree about a branch leave the gan with two numbers
 * and no way to tell which is true.
 *
 * What this adds over the screen is the part a browser is bad at: a file to
 * read line by line, and the warnings that matter before a rollout.
 *
 * Read-only. It writes nothing, ever.
 *
 *   node scripts/parent-pilot-report.js                              # list branches
 *   node scripts/parent-pilot-report.js --branch "<סניף>"
 *   node scripts/parent-pilot-report.js --branch "<סניף>" --classroom "תינוקיה"
 *   node scripts/parent-pilot-report.js --branch "<סניף>" --csv
 *
 * --csv writes the parent list to a spreadsheet on the Desktop instead of
 * printing it. Use it rather than --names: a terminal line that mixes Hebrew
 * names with Latin digits is reordered on screen, and the ת.ז and the mobile
 * run into each other and read as one impossible nineteen-digit number.
 *
 * Three things decide whether a parent can activate, and all three are
 * enrolment data rather than anything the portal owns:
 *
 *   ת.ז    on the child's parent slot, the second-parent slot, or — for most
 *          families — on the REGISTRATION behind the child.
 *   נייד   must normalise to 05XXXXXXXX. THE DANGEROUS CASE IS NOT LISTED
 *          ANYWHERE: a number that is valid but WRONG looks like a success
 *          and sends the code to a stranger. Only a human reading the list
 *          can catch that, which is why --csv exists.
 *   כיתה   no classroom means no branch, and the daily board, the menu and
 *          the announcements all hang off the branch.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const os = require('os');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
}
const WITH_NAMES = process.argv.includes('--names');
const AS_CSV = process.argv.includes('--csv');

const pad = (s, n) => String(s ?? '').padEnd(n);

/**
 * One line of the parent list, written so a terminal cannot scramble it.
 *
 * Columns are separated by a visible bar and not by spaces. In a line that
 * mixes Hebrew with Latin digits the terminal reorders the runs and eats the
 * padding, and the ת.ז and the mobile end up touching — they read as one
 * nineteen-digit number, which is what sent somebody looking for a data bug
 * that was not there.
 */
const row = (...cells) => `  ${cells.join(' | ')}`;

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * A mobile number that survives being opened in a spreadsheet.
 *
 * `0546136599` is digits, so Numbers and Excel read it as a number and print
 * it back without the leading zero — the one digit that makes it a phone
 * number. The dash settles it, and is how an Israeli mobile is written down.
 */
const csvPhone = (p) => {
  const s = String(p || '');
  return /^0\d{9}$/.test(s) ? `${s.slice(0, 3)}-${s.slice(3)}` : s;
};

/**
 * And the same hazard on the ת.ז, which is quieter and worse: some genuinely
 * start with a zero, and unlike the phone the mangled result does not look
 * wrong — it is simply a different, valid-looking ID.
 */
const csvId = (id) => {
  const s = String(id || '').padStart(9, '0');
  return /^0/.test(s) ? `="${s}"` : s;
};

const STATE_LABEL = {
  active: 'הפעיל',
  not_signed_up: 'ממתין',
  blocked: 'חסום',
  awaiting_approval: 'ממתין לאישור',
  closed: 'סגור',
};

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI חסר');
  await mongoose.connect(uri);
  console.log(`מסד: ${mongoose.connection.host}/${mongoose.connection.name}\n`);

  const { Branch, Classroom, Child } = require('../src/models');
  const { signups } = require('../src/services/parentSignups.service');
  const nursery = require('../src/services/nursery.service');

  const wanted = arg('branch');
  const branches = await Branch.find({ is_active: true }).select('name').sort({ name: 1 }).lean();

  if (!wanted) {
    console.log('יש לציין סניף: --branch "<שם>"\n\nהסניפים הפעילים:');
    for (const b of branches) console.log(`  ${b.name}`);
    process.exitCode = 1;
    return;
  }

  const branch = branches.find(b => b.name === wanted);
  if (!branch) {
    console.log(`לא נמצא סניף בשם "${wanted}". הסניפים הפעילים:`);
    for (const b of branches) console.log(`  ${b.name}`);
    process.exitCode = 1;
    return;
  }

  const wantedRoom = arg('classroom');
  const allRooms = await Classroom.find({ branch_id: branch._id }).select('_id name category').lean();
  const rooms = wantedRoom
    ? allRooms.filter(r => String(r.name || '').includes(wantedRoom))
    : allRooms;
  if (wantedRoom && !rooms.length) {
    console.log(`לא נמצאה כיתה שמכילה "${wantedRoom}" ב-${branch.name}. הכיתות:`);
    for (const r of allRooms) console.log(`  ${r.name}`);
    process.exitCode = 1;
    return;
  }

  const data = await signups({
    branchIds: [String(branch._id)],
    classroom: wantedRoom || '',
  });
  const { parents, summary } = data;

  const scope = wantedRoom ? `${branch.name} / ${rooms.map(r => r.name).join(', ')}` : branch.name;
  console.log(`=== ${scope} — מצב ההורים לקראת הפיילוט ===`);
  console.log(`${summary.children} ילדים פעילים, ${rooms.length} כיתות\n`);

  // Which rooms have a daily board at all. A pilot about the board does not
  // reach a room that deliberately has none.
  console.log('לוח יומי לפי כיתה');
  const children = await Child.find({ is_active: true, classroom_id: { $in: rooms.map(r => r._id) } })
    .select('classroom_id').lean();
  for (const r of rooms) {
    const n = children.filter(c => String(c.classroom_id) === String(r._id)).length;
    if (!n) continue;
    const label = { full: 'לוח מלא', light: 'לוח מקוצר', none: 'ללא לוח' }[nursery.boardKind(r)] || '';
    console.log(`  ${pad(r.name, 16)} ${pad(`${n} ילדים`, 12)} ${label}`);
  }

  console.log('\nהורים');
  console.log(`  ${pad('סך הכול', 26)} ${summary.parents}`);
  console.log(`  ${pad('כבר הפעילו חשבון', 26)} ${summary.active}`);
  console.log(`  ${pad('יכולים להפעיל עכשיו', 26)} ${summary.not_signed_up}`);
  console.log(`  ${pad('חסומים — לא יוכלו בכלל', 26)} ${summary.blocked}`);
  console.log(`  ${pad('ממתינים לאישור הגן', 26)} ${summary.awaiting_approval}`);
  console.log(`  ${pad('חשבון סגור', 26)} ${summary.closed}`);
  if (summary.children_without_parent_id) {
    console.log(`  ${pad('ילדים בלי ת.ז הורה בכלל', 26)} ${summary.children_without_parent_id}`);
  }

  const blocked = parents.filter(p => p.state === 'blocked');
  if (blocked.length) {
    console.log('\n❗ חסומים — אלה לא יוכלו להיכנס עד שהמשרד יעדכן');
    for (const p of blocked) {
      const why = p.blocked_reason === 'no_phone' ? 'אין נייד תקין' : 'אין ת.ז';
      console.log(row(pad(p.id_number, 11), pad(why, 14), `${p.name || '(ללא שם)'} — ${p.children.map(c => c.name).join(', ')}`));
    }
  }

  if (data.children_without_parent_id.length) {
    console.log('\n❗ ילדים שאין עליהם ת.ז הורה באף אחד משלושת המקומות');
    for (const c of data.children_without_parent_id) {
      console.log(`  ${pad(c.child_name, 20)} ${c.classroom}`);
    }
  }

  const sorted = [...parents].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'he'));

  if (AS_CSV) {
    const safeName = scope.replace(/[\\/:]/g, '-');
    const file = arg('csv-path') || path.join(os.homedir(), 'Desktop', `הורים - ${safeName}.csv`);
    const lines = [['מצב', 'תעודת זהות', 'נייד', 'שם ההורה', 'ילדים'].map(csvCell).join(',')];
    for (const p of sorted) {
      lines.push([
        csvCell(STATE_LABEL[p.state] || p.state), csvId(p.id_number), csvPhone(p.phone),
        csvCell(p.name || ''), csvCell(p.children.map(c => c.name).join(' · ')),
      ].join(','));
    }
    // BOM, or Excel reads the Hebrew as mojibake.
    fs.writeFileSync(file, `﻿${lines.join('\n')}\n`, 'utf8');
    console.log(`\n📄 ${sorted.length} הורים נכתבו לקובץ:`);
    console.log(`   ${file}`);
    console.log('\n   הקובץ מכיל תעודות זהות ומספרי טלפון של משפחות.');
    console.log('   אחרי שעברתם עליו — מחקו אותו.');
  } else if (WITH_NAMES) {
    console.log('\n--- כל ההורים, עם הנייד שהקוד יישלח אליו ---');
    console.log('מספר תקין אבל שגוי נראה כמו הצלחה ושולח את הקוד לזר.');
    console.log('(--csv במקום --names נותן קובץ לנאמברס, קריא הרבה יותר)\n');
    console.log(row(pad('מצב', 6), pad('תעודת זהות', 11), pad('נייד', 10), 'שם / ילדים'));
    for (const p of sorted) {
      console.log(row(
        pad(STATE_LABEL[p.state] || p.state, 6), pad(p.id_number, 11), pad(p.phone || '—', 10),
        `${p.name || '(ללא שם)'} — ${p.children.map(c => c.name).join(', ')}`,
      ));
    }
  } else {
    console.log('\n(--csv כדי לקבל את כל ההורים והניידים כקובץ לנאמברס)');
  }

  console.log('');
}

main()
  .catch((err) => { console.error(`\n❌ ${err.message}`); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
