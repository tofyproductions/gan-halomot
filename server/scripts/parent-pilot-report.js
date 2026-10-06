#!/usr/bin/env node
/**
 * Can this branch's parents actually get in, and who already has?
 *
 * The portal has no enable switch — every parent of an active child can sign in
 * today — so "roll out a branch" is not a deploy, it is finding out which
 * families the DATA lets in and fixing the ones it does not. This is the
 * report for that, and it exists because nothing else in the system can answer
 * it: there is no parent-accounts screen anywhere.
 *
 * Read-only. It writes nothing, ever.
 *
 *   node scripts/parent-pilot-report.js                              # list branches
 *   node scripts/parent-pilot-report.js --branch "כפר סבא - משה דיין"
 *   node scripts/parent-pilot-report.js --branch "כפר סבא - משה דיין" --names
 *
 * Three things decide whether a parent can activate, and all three are
 * enrolment data rather than anything the portal owns (see
 * parentDirectory.service):
 *
 *   ת.ז    on the child's parent slot, the second-parent slot, or — for most
 *          families — on the REGISTRATION behind the child. Missing means the
 *          sign-in screen tells them their ID is not registered here.
 *   נייד   must normalise to 05XXXXXXXX. A landline reads as no phone and they
 *          are told to call the gan. THE DANGEROUS CASE IS NOT LISTED HERE:
 *          a number that is valid but WRONG looks like a success and sends the
 *          code to a stranger. Only a human reading the list can catch that,
 *          which is why --names exists.
 *   כיתה   no classroom means no branch, and the daily board, the menu and the
 *          announcements all hang off the branch.
 *
 * And `boardKind` decides whether the daily board appears at all: תינוקייה gets
 * the full board, בוגרים and צעירים get none, everything else gets the light
 * one. A pilot about the daily board only means something for the rooms that
 * have one.
 */
require('dotenv').config();
const mongoose = require('mongoose');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
}
const WITH_NAMES = process.argv.includes('--names');

const pad = (s, n) => String(s ?? '').padEnd(n);

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI חסר');
  await mongoose.connect(uri);
  console.log(`מסד: ${mongoose.connection.host}/${mongoose.connection.name}\n`);

  const { Branch, Child, ParentAccount, Classroom } = require('../src/models');
  const { contactFromChild, normalizeIdNumber } = require('../src/services/parentDirectory.service');
  const { normalizePhone } = require('../src/services/sms.service');
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

  const rooms = await Classroom.find({ branch_id: branch._id }).select('_id name category').lean();
  const roomIds = rooms.map(r => r._id);
  const roomById = new Map(rooms.map(r => [String(r._id), r]));

  // Active children of this branch, by classroom — the same way the portal
  // resolves a child's branch, so the two agree about who is in the pilot.
  const children = await Child.find({ is_active: true, classroom_id: { $in: roomIds } })
    .populate('registration_id', 'parent_name parent_phone parent_id_number start_date end_date')
    .populate('classroom_id', 'name category branch_id')
    .sort({ child_name: 1 })
    .lean();

  console.log(`=== ${branch.name} — מצב ההורים לקראת הפיילוט ===`);
  console.log(`${children.length} ילדים פעילים, ${rooms.length} כיתות\n`);

  /**
   * Every (parent ID → the children they would see) in this branch.
   *
   * Keyed on the ID number rather than on the child, because an account is a
   * person and a person is a family: two siblings are one activation, and the
   * announcement SMS counts phones for the same reason.
   */
  const parents = new Map();
  const noParentId = [];

  for (const child of children) {
    const reg = child.registration_id;
    const ids = new Set();
    for (const raw of [child.parent_id_number, child.parent2_id_number, reg?.parent_id_number]) {
      const id = normalizeIdNumber(raw);
      if (id) ids.add(id);
    }

    if (!ids.size) {
      noParentId.push(child);
      continue;
    }

    for (const id of ids) {
      if (!parents.has(id)) parents.set(id, { id, children: [], name: '', phone: null });
      const entry = parents.get(id);
      entry.children.push(child);
      const { name, phone } = contactFromChild(child, id);
      if (!entry.name && name) entry.name = name;
      if (!entry.phone && phone) entry.phone = phone;
    }
  }

  // Which of them already activated. There is no screen for this.
  const accounts = await ParentAccount.find({ id_number: { $in: [...parents.keys()] } })
    .select('id_number activated is_active access_approved last_login_at')
    .lean();
  const accountById = new Map(accounts.map(a => [normalizeIdNumber(a.id_number), a]));

  const canActivate = [];
  const noPhone = [];
  const activated = [];
  const blocked = [];

  for (const entry of parents.values()) {
    const account = accountById.get(entry.id) || null;
    entry.account = account;

    if (account && account.is_active === false) { blocked.push(entry); continue; }
    if (account && account.access_approved === false) { blocked.push(entry); continue; }
    if (account && account.activated) { activated.push(entry); continue; }
    if (!entry.phone) { noPhone.push(entry); continue; }
    canActivate.push(entry);
  }

  // Which rooms have a daily board at all. A pilot about the board does not
  // reach a room that deliberately has none.
  console.log('לוח יומי לפי כיתה');
  for (const room of rooms) {
    const inRoom = children.filter(c => String(c.classroom_id?._id || c.classroom_id) === String(room._id));
    if (!inRoom.length) continue;
    const kind = nursery.boardKind(room);
    const label = { full: 'לוח מלא', light: 'לוח מקוצר', none: 'ללא לוח' }[kind] || kind;
    console.log(`  ${pad(room.name, 16)} ${pad(`${inRoom.length} ילדים`, 12)} ${label}`);
  }

  console.log('\nהורים');
  console.log(`  ${pad('סך הכול', 26)} ${parents.size}`);
  console.log(`  ${pad('כבר הפעילו חשבון', 26)} ${activated.length}`);
  console.log(`  ${pad('יכולים להפעיל עכשיו', 26)} ${canActivate.length}`);
  console.log(`  ${pad('בלי נייד תקין — חוסם', 26)} ${noPhone.length}`);
  console.log(`  ${pad('חשבון סגור / ממתין לאישור', 26)} ${blocked.length}`);
  if (noParentId.length) {
    console.log(`  ${pad('ילדים בלי ת.ז הורה בכלל', 26)} ${noParentId.length}`);
  }

  if (noPhone.length) {
    console.log('\n❗ בלי מספר נייד תקין — אלה לא יוכלו להיכנס עד שהמשרד יעדכן');
    for (const e of noPhone) {
      const kids = e.children.map(c => c.child_name).join(', ');
      console.log(`  ${pad(e.id, 11)} ${pad(e.name || '(ללא שם)', 18)} ${kids}`);
    }
  }

  if (noParentId.length) {
    console.log('\n❗ ילדים שאין עליהם ת.ז הורה באף אחד משלושת המקומות');
    for (const c of noParentId) {
      console.log(`  ${pad(c.child_name, 20)} ${roomById.get(String(c.classroom_id?._id || c.classroom_id))?.name || ''}`);
    }
  }

  if (blocked.length) {
    console.log('\n⚠️  חשבונות שלא ייכנסו גם עם ת.ז ונייד תקינים');
    for (const e of blocked) {
      const why = e.account?.is_active === false ? 'החשבון סגור' : 'ממתין לאישור הגן';
      console.log(`  ${pad(e.id, 11)} ${pad(e.name || '(ללא שם)', 18)} ${why}`);
    }
  }

  // Enrolment dates decide which year's row the portal calls "now". Without
  // them it falls back to the newest, which in Aug–Sep is NEXT year — and the
  // daily board disappears from a parent's screen when next year's room is a
  // category that has no board.
  const noDates = children.filter(c => {
    const reg = c.registration_id;
    return !reg || !reg.start_date || !reg.end_date;
  });
  if (noDates.length) {
    console.log(`\n⚠️  ${noDates.length} ילדים בלי תאריכי התחלה/סיום ברישום.`);
    console.log('   לא חוסם כניסה, אבל באוגוסט–ספטמבר הפורטל עלול להציג את כיתת');
    console.log('   השנה הבאה כאילו היא ההווה, ואז הלוח היומי נעלם מהמסך שלהם.');
    for (const c of noDates.slice(0, 15)) console.log(`     ${c.child_name}`);
    if (noDates.length > 15) console.log(`     ...ועוד ${noDates.length - 15}`);
  }

  if (WITH_NAMES) {
    console.log('\n--- כל ההורים, עם הנייד שהקוד יישלח אליו ---');
    console.log('קראו את השורות. מספר תקין אבל שגוי נראה כמו הצלחה ושולח את הקוד לזר.\n');
    const all = [...parents.values()].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'he'));
    for (const e of all) {
      const state = e.account?.activated ? 'הפעיל' : (e.phone ? 'ממתין' : 'חסום');
      const kids = e.children.map(c => c.child_name).join(', ');
      console.log(`  ${pad(state, 7)} ${pad(e.id, 11)} ${pad(e.phone || '—', 12)} ${pad(e.name || '(ללא שם)', 18)} ${kids}`);
    }
  } else {
    console.log('\n(--names כדי לראות את כל ההורים והנייד שהקוד יישלח אליו)');
  }

  console.log('');
}

main()
  .catch((err) => { console.error(`\n❌ ${err.message}`); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
