#!/usr/bin/env node
/**
 * REMOVE THE PASSWORD THAT IS A PERSON'S ת"ז.
 *
 * userSync used to create a staff account with `password_hash = bcrypt(ת"ז)`
 * and `password_set: false`, on the reasoning that nothing checks the hash
 * while that flag is false. That was true: `login-password` refuses any
 * account with `password_set` false, so none of these hashes has ever opened
 * anything, and this is not a live hole.
 *
 * It is a trap, though. The day somebody flips `password_set` to true on one of
 * these rows — a migration, a fix-up script, a well-meant admin button — the
 * account's password becomes a number printed on the person's documents and
 * held by every employer they have ever had. 58 of the gan's 73 active
 * accounts were in that state on 07.10.2026.
 *
 * So the value is replaced with random bytes nobody will ever know. Nothing
 * reads it: a first sign-in goes through a code texted to the mobile on the
 * records, and the person chooses their own password at the end of it. The
 * only thing this changes is that the trap is gone.
 *
 * It touches ONLY rows where both are true — the hash is the ת"ז, and
 * `password_set` is false. An account somebody has actually chosen a password
 * on is never written to.
 *
 *   node scripts/scrub-id-number-passwords.js            # report only
 *   node scripts/scrub-id-number-passwords.js --write    # and replace them
 */
require('dotenv').config();

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const WRITE = process.argv.includes('--write');

(async () => {
  if (!process.env.MONGODB_URI) {
    console.error('\n❌  חסר MONGODB_URI\n');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI);
  const users = mongoose.connection.collection('users');

  const rows = await users
    .find({}, { projection: { full_name: 1, id_number: 1, password_set: 1, password_hash: 1, is_active: 1 } })
    .toArray();

  const hits = [];
  let skippedChosen = 0;

  for (const u of rows) {
    const id = String(u.id_number || '').replace(/\D/g, '');
    if (id.length !== 9 || !u.password_hash) continue;
    if (!bcrypt.compareSync(id, u.password_hash)) continue;
    // Somebody chose this password deliberately — however bad a choice it is,
    // overwriting it would lock them out, and that is a different decision
    // made by a different person.
    if (u.password_set) { skippedChosen++; continue; }
    hits.push(u);
  }

  console.log(`\nנבדקו ${rows.length} חשבונות.`);
  console.log(`הסיסמה היא הת"ז, והחשבון בלי סיסמה שנבחרה: ${hits.length}`);
  if (skippedChosen) {
    console.log(`⚠️  ועוד ${skippedChosen} שבחרו את הת"ז כסיסמה בעצמם — לא נוגעים, זה ינעל אותם.`);
    console.log('   אלה כן חור חי. יש לבקש מהם לשנות סיסמה.');
  }
  for (const u of hits) {
    console.log(`  • ${u.full_name}${u.is_active === false ? ' (לא פעיל)' : ''}`);
  }

  if (!hits.length) {
    console.log('\n✅  אין מה לנקות.\n');
  } else if (!WRITE) {
    console.log('\nדיווח בלבד. להחלפה בפועל:  node scripts/scrub-id-number-passwords.js --write\n');
  } else {
    let done = 0;
    for (const u of hits) {
      const hash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);
      // Guarded on password_set in the filter too, so a flag flipped between
      // the read and the write cannot be overwritten from under somebody.
      const r = await users.updateOne(
        { _id: u._id, password_set: { $ne: true } },
        { $set: { password_hash: hash } },
      );
      done += r.modifiedCount;
    }
    console.log(`\n✅  הוחלפו ${done} גיבובים. אף אחד לא ננעל — ממילא אי אפשר היה להיכנס איתם.\n`);
  }

  await mongoose.disconnect();
})().catch((e) => { console.error('\n💥', e.message); process.exit(1); });
