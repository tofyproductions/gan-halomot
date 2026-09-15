#!/usr/bin/env node
/**
 * Rotate the database password inside the CUSTOMER RECORDS, not just the
 * environment.
 *
 * WHY THIS IS A SEPARATE PROBLEM. A customer is not reached through
 * MONGODB_URI. The resolver looks the customer up in the control plane and
 * connects with the `db_uri` stored on that customer's own row — which is the
 * whole point: customer 131 goes on another cluster by editing one field.
 *
 * So rotating the Atlas password and updating Render fixes the processes and
 * leaves every customer pointing at a password that no longer exists. The
 * symptom is exact and misleading: /api/health says ok, because it never
 * touches a customer database, and the first real request answers
 * "bad auth : authentication failed" from a service whose environment is
 * perfectly correct.
 *
 * Dry run by default. Prints which customers carry the old password and
 * changes nothing until --yes.
 *
 *   node scripts/ganflow-rotate-tenant-uri.js
 *   node scripts/ganflow-rotate-tenant-uri.js --yes
 *
 * Nothing is printed that reveals a password: only its length, and whether two
 * strings match.
 */

const readline = require('readline');
const WRITE = process.argv.includes('--yes');

function parse(uri) {
  const m = String(uri || '').match(/^mongodb(\+srv)?:\/\/([^:]*):([^@]*)@([^/?]+)(?:\/([^?]*))?(\?.*)?$/);
  if (!m) return null;
  return { user: m[2], pass: m[3], host: m[4], db: m[5] || '', query: m[6] || '' };
}

const ask = (rl, q) => new Promise(r => rl.question(q, a => r(a.trim())));

/**
 * Ask for something that must not appear on screen.
 *
 * readline echoes what is typed, which is correct for a filename and wrong for
 * a password: it leaves the secret sitting in the scrollback, in a screenshot,
 * and in whatever the terminal keeps. This version prints nothing back. Found
 * the hard way — the first run of this tool put a live database password into
 * a screenshot, and the password had to be rotated again.
 */
function askSecret(q) {
  return new Promise((resolve) => {
    process.stdout.write(q);
    const { stdin } = process;
    const wasRaw = stdin.isRaw;
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();
    let buf = '';
    const onData = (ch) => {
      const s = String(ch);
      if (s === '\n' || s === '\r' || s === '\u0004') {
        if (stdin.setRawMode) stdin.setRawMode(Boolean(wasRaw));
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(buf.trim());
      } else if (s === '\u0003') {          // ctrl-c
        process.stdout.write('\n');
        process.exit(1);
      } else if (s === '\u007f' || s === '\b') {
        buf = buf.slice(0, -1);
      } else {
        buf += s;
      }
    };
    stdin.on('data', onData);
  });
}

(async () => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('\nהכלי מעדכן את כתובת המסד ששמורה על כל לקוח במסד הבקרה.');
  console.log('הסיסמאות לא מודפסות ולא נשלחות לשום מקום.\n');

  rl.close();
  const controlUri = await askSecret('הדבק את PLATFORM_MONGODB_URI (לא יוצג על המסך):\n> ');
  const newPass = await askSecret('\nהדבק את הסיסמה החדשה (לא תוצג על המסך):\n> ');
  console.log('');

  const cp = parse(controlUri);
  if (!cp) { console.log('❌ מחרוזת הבקרה אינה בפורמט תקין.'); process.exit(1); }
  if (!newPass) { console.log('❌ לא הודבקה סיסמה.'); process.exit(1); }

  let MongoClient;
  try { ({ MongoClient } = require('mongodb')); }
  catch { console.log('❌ חבילת mongodb אינה מותקנת.'); process.exit(1); }

  const client = new MongoClient(controlUri, { serverSelectionTimeoutMS: 15000 });
  try {
    await client.connect();
  } catch (err) {
    console.log('❌ אי אפשר להתחבר למסד הבקרה:', String(err.message).slice(0, 120));
    process.exit(1);
  }

  /**
   * Prove this is the control plane before believing what it says.
   *
   * The first version trusted whatever string it was handed and ran
   * find({}) on `tenants`. Paste the DEMO's connection string by mistake and
   * mongo answers cheerfully: no such collection is not an error, it is an
   * empty result. The tool reported "0 customers" with total confidence, the
   * real customer sat two databases away still holding the old password, and
   * the wrong conclusion cost an hour.
   *
   * So: name the database out loud, and refuse when the collection that
   * defines a control plane is not there.
   */
  const db = client.db();
  const names = (await db.listCollections().toArray()).map(c => c.name);
  console.log(`מסד: ${db.databaseName}`);
  if (!names.includes('tenants')) {
    console.log('');
    console.log(`❌ במסד "${db.databaseName}" אין אוסף בשם tenants.`);
    console.log('   זה אינו מסד הבקרה. כנראה הודבקה המחרוזת הלא נכונה.');
    console.log('   צריך את PLATFORM_MONGODB_URI — זה שנגמר ב-/gf_control.');
    console.log(`   האוספים שנמצאו כאן: ${names.slice(0, 6).join(', ')}${names.length > 6 ? ` ועוד ${names.length - 6}` : ''}`);
    await client.close();
    process.exit(1);
  }

  const tenants = db.collection('tenants');
  const rows = await tenants.find({}).toArray();
  console.log(`\n─── ${rows.length} לקוחות במסד הבקרה ───\n`);
  if (!rows.length) {
    console.log('  ⚠️  אוסף הלקוחות ריק. אם כתובת של לקוח כן עונה — משהו כאן לא מסתדר.');
  }

  const toFix = [];
  for (const t of rows) {
    const p = parse(t.db_uri);
    if (!t.db_uri) {
      console.log(`  ${String(t.slug).padEnd(14)} ללא כתובת משלו — נופל ל-PLATFORM_TENANT_URI`);
      continue;
    }
    if (!p) {
      console.log(`  ${String(t.slug).padEnd(14)} ⚠️  כתובת לא תקינה`);
      continue;
    }
    const same = p.pass === newPass;
    console.log(`  ${String(t.slug).padEnd(14)} מסד=${(t.db_name || p.db || '?').padEnd(16)} סיסמה: ${p.pass.length} תווים  ${same ? '✅ כבר מעודכנת' : '⚠️  ישנה'}`);
    if (!same) toFix.push({ t, p });
  }

  console.log('');
  if (!toFix.length) { console.log('✅ אין מה לעדכן.'); await client.close(); process.exit(0); }

  if (!WRITE) {
    console.log(`👁️   ריצה יבשה. ${toFix.length} לקוחות ממתינים לעדכון, לא נכתב כלום.`);
    console.log('   להרצה אמיתית הוסף --yes\n');
    await client.close();
    process.exit(0);
  }

  for (const { t, p } of toFix) {
    const updated = `mongodb${p.host.includes('.mongodb.net') ? '+srv' : ''}://${p.user}:${newPass}@${p.host}/${p.db}${p.query}`;
    // Verify the new string works BEFORE storing it. Writing a broken address
    // onto a customer is the same outage with an extra step to undo.
    const probe = new MongoClient(updated, { serverSelectionTimeoutMS: 15000 });
    try {
      await probe.connect();
      await probe.db().listCollections().toArray();
      await probe.close();
    } catch (err) {
      console.log(`  ❌ ${t.slug}: הכתובת החדשה לא עובדת — לא נשמרה. (${String(err.message).slice(0, 60)})`);
      continue;
    }
    await tenants.updateOne({ _id: t._id }, { $set: { db_uri: updated, updated_at: new Date() } });
    console.log(`  ✅ ${t.slug}: עודכן ונבדק`);
  }

  console.log('\n✅ סיום. יש להפעיל מחדש את השירות ganflow ב-Render כדי לנקות חיבורים ישנים.\n');
  await client.close();
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
