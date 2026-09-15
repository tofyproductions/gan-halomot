#!/usr/bin/env node
/**
 * "Does this connection string actually work?" — answered locally.
 *
 * WHY THIS EXISTS. A wrong connection string fails as `bad auth :
 * authentication failed`, which is the same message for four different
 * mistakes: the wrong password, a password with a character that breaks the
 * URI, a stray space, and a user that was edited in a different Atlas project.
 * Guessing between them from a dashboard costs an afternoon.
 *
 * It never prints the password, and the string never leaves the machine.
 *
 *   node scripts/check-mongo-uri.js
 *   (paste the string when asked, press Enter)
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
      } else if (s === '\u0003') { process.stdout.write('\n'); process.exit(1); }
      else if (s === '\u007f' || s === '\b') { buf = buf.slice(0, -1); }
      else { buf += s; }
    };
    stdin.on('data', onData);
  });
}

function describe(uri) {
  const m = uri.match(/^mongodb(\+srv)?:\/\/([^:]*):([^@]*)@([^/?]+)(?:\/([^?]*))?(\?.*)?$/);
  if (!m) return null;
  const [, srv, user, pass, host, db, query] = m;
  return { srv: Boolean(srv), user, pass, host, db: db || '', query: query || '' };
}

const RISKY = ['@', ':', '/', '?', '#', '%', '&', ' '];

(async () => {
  /**
   * Not echoed. A connection string carries a live password, and readline's
   * default behaviour leaves it in the scrollback and in any screenshot of it.
   */
  const uri = (await askSecret('\nהדבק כאן את מחרוזת החיבור ולחץ Enter (לא תוצג על המסך):\n> ')).trim();

  console.log('');
  if (!uri) { console.log('❌ לא הודבק כלום.'); process.exit(1); }

  const p = describe(uri);
  if (!p) {
    console.log('❌ המחרוזת אינה בפורמט תקין.');
    console.log('   היא צריכה להיראות כך:');
    console.log('   mongodb+srv://משתמש:סיסמה@אשכול.mongodb.net/שם_מסד?פרמטרים');
    process.exit(1);
  }

  console.log('─── מה יש במחרוזת ───');
  console.log('  משתמש      :', p.user || '(ריק!)');
  console.log('  אורך סיסמה :', p.pass.length, 'תווים');
  console.log('  אשכול      :', p.host);
  console.log('  שם מסד     :', p.db || '⚠️  (חסר!)');
  console.log('  פרמטרים    :', p.query || '(אין)');
  console.log('');

  let problems = 0;
  const bad = RISKY.filter(c => p.pass.includes(c));
  if (bad.length) {
    problems++;
    console.log('⚠️  הסיסמה מכילה תווים ששוברים את המחרוזת:', bad.map(c => c === ' ' ? '[רווח]' : c).join(' '));
    console.log('   זו הסיבה הכי שכיחה ל-"bad auth". צור סיסמה חדשה מאותיות ומספרים בלבד.');
  }
  if (/^\s|\s$/.test(p.pass)) { problems++; console.log('⚠️  יש רווח בתחילת או בסוף הסיסמה.'); }
  if (!p.db) { problems++; console.log('⚠️  חסר שם מסד אחרי הסלאש.'); }
  if (problems) console.log('');

  console.log('─── מנסה להתחבר ───');
  let MongoClient;
  try { ({ MongoClient } = require('mongodb')); }
  catch { console.log('❌ חבילת mongodb אינה מותקנת. הרץ: npm install --no-save mongodb'); process.exit(1); }

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  try {
    await client.connect();
    const db = client.db();
    const cols = await db.listCollections().toArray();
    console.log('✅ החיבור הצליח.');
    console.log('   מסד:', db.databaseName);
    console.log('   אוספים:', cols.length);
    if (cols.length) console.log('   דוגמה:', cols.slice(0, 5).map(c => c.name).join(', '));
    await client.close();
    process.exit(0);
  } catch (err) {
    const msg = String(err.message || err);
    console.log('❌ החיבור נכשל.');
    console.log('');
    if (/bad auth|Authentication failed/i.test(msg)) {
      console.log('   הסיבה: שם המשתמש או הסיסמה שגויים.');
      console.log('   מה לבדוק, לפי הסבירות:');
      console.log('     1. הסיסמה באטלס באמת נשמרה (Update User נלחץ)');
      console.log('     2. הסיסמה הודבקה במלואה, בלי לחתוך תו');
      console.log('     3. אין תווים מיוחדים בסיסמה');
      console.log('     4. המשתמש נמצא באותו פרויקט באטלס שבו האשכול הזה');
    } else if (/ENOTFOUND|querySrv|getaddrinfo/i.test(msg)) {
      console.log('   הסיבה: כתובת האשכול לא נמצאה. בדוק את החלק שאחרי ה-@.');
    } else if (/timed out|ETIMEDOUT/i.test(msg)) {
      console.log('   הסיבה: אין מענה מהאשכול. ייתכן שכתובת ה-IP שלך חסומה');
      console.log('   ב-Atlas ← Network Access.');
    } else {
      console.log('   ההודעה:', msg.slice(0, 200));
    }
    await client.close().catch(() => {});
    process.exit(1);
  }
})();
