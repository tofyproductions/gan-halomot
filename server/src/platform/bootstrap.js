const bcrypt = require('bcryptjs');
const { controlPlane } = require('./connection');

/**
 * The first console account, created at boot from the environment.
 *
 * There is a script that does this (`scripts/ganflow-platform-seed.js`) and it
 * remains the right tool on a laptop. It is the wrong tool for the person who
 * has to switch the platform on: it needs a checkout, Node, and the control
 * plane's credentials on the machine running it — and Render's free tier has
 * no shell to run it in. Without this, switching the customer layer on ends at
 * a login screen that refuses every password with no way in.
 *
 * THREE THINGS MAKE IT SAFE TO READ A PASSWORD FROM THE ENVIRONMENT:
 *
 *   - it runs ONLY when the control plane has no users at all. Once there is
 *     one account, this is inert — the variables can be left behind, and
 *     nothing they say can change an existing password or add an owner.
 *   - it never overwrites. A control plane with users is never touched.
 *   - it says out loud what it did, so the boot log is the record.
 *
 * The variables should still be deleted after the first boot. They are as
 * strong as the account they made, and an environment variable is visible to
 * anyone who can open the dashboard.
 */
async function seedOwnerFromEnv() {
  const email = String(process.env.PLATFORM_OWNER_EMAIL || '').toLowerCase().trim();
  // Trimmed, because a value pasted into a dashboard field carries whatever
  // came with it. A trailing space makes a password that is right and does not
  // work, and there is no screen anywhere that would show it.
  const password = String(process.env.PLATFORM_OWNER_PASSWORD || '').trim();

  const { PlatformUser } = await controlPlane();
  const existing = await PlatformUser.countDocuments();

  if (!email || !password) {
    // SILENCE HERE WAS THE BUG. A missing or misspelled variable produced no
    // user and no message, and the next thing that happens is a person typing
    // a correct password into a login screen that refuses it, with nothing
    // anywhere saying why. If there is nobody to log in as, say so.
    if (existing === 0) {
      console.error('⚠️  אין אף משתמש קונסולה, ואין PLATFORM_OWNER_EMAIL / PLATFORM_OWNER_PASSWORD.');
      console.error(`    נמצא: EMAIL=${email ? 'כן' : 'לא'} PASSWORD=${password ? 'כן' : 'לא'}`);
      console.error('    בלי שניהם אי אפשר להיכנס לקונסולה — אין מסך הרשמה.');
    }
    return { seeded: false, reason: 'not asked for' };
  }

  if (password.length < 10) {
    console.error(`⚠️  PLATFORM_OWNER_PASSWORD קצרה מדי (${password.length} תווים) — צריך לפחות 10. לא נוצר משתמש.`);
    return { seeded: false, reason: 'password too short' };
  }

  // Not `findOne({ email })` — ANY existing account means the console has an
  // owner already, and a second one appearing at boot is how an environment
  // variable becomes a way in.
  if (existing > 0) {
    console.log(`ℹ️  יש כבר ${existing} משתמשי קונסולה — PLATFORM_OWNER_* לא עשה כלום. אפשר למחוק אותם.`);
    return { seeded: false, reason: 'already has users' };
  }

  await PlatformUser.create({
    email,
    full_name: process.env.PLATFORM_OWNER_NAME || '',
    role: 'owner',
    password_hash: await bcrypt.hash(password, 12),
  });

  console.log(`✅  נוצר חשבון הבעלים הראשון לקונסולה: ${email}`);
  console.log('    ⚠️  למחוק עכשיו את PLATFORM_OWNER_EMAIL / NAME / PASSWORD מהסביבה.');
  return { seeded: true, email };
}

/**
 * Everything the customer layer needs before anybody tries to use it.
 *
 * PLATFORM_JWT_SECRET has no default and is read at LOGIN rather than at boot,
 * so a server missing it starts perfectly, serves the console, and fails at
 * the one moment a person is typing a password — with an English exception on
 * a Hebrew screen. Same shape as the silent seeder: a configuration mistake
 * that only appears as a login that will not work.
 *
 * Checked out loud at boot instead, while somebody is still looking at the
 * deploy log.
 */
function checkConfig() {
  const missing = [];
  if (!process.env.PLATFORM_JWT_SECRET) missing.push('PLATFORM_JWT_SECRET — מפתח החתימה של הקונסולה');
  if (!process.env.PLATFORM_TENANT_URI) missing.push('PLATFORM_TENANT_URI — איפה נפתחים מסדי הלקוחות');
  if (missing.length) {
    console.error('⚠️  שכבת הלקוחות דלוקה אבל חסרים משתנים:');
    for (const m of missing) console.error('    • ' + m);
  }
  return missing;
}

module.exports = { seedOwnerFromEnv, checkConfig };
