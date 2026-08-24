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
  const password = process.env.PLATFORM_OWNER_PASSWORD || '';
  if (!email || !password) return { seeded: false, reason: 'not asked for' };

  if (password.length < 10) {
    console.error('⚠️  PLATFORM_OWNER_PASSWORD קצרה מדי — לפחות 10 תווים. לא נוצר משתמש.');
    return { seeded: false, reason: 'password too short' };
  }

  const { PlatformUser } = await controlPlane();

  // Not `findOne({ email })` — ANY existing account means the console has an
  // owner already, and a second one appearing at boot is how an environment
  // variable becomes a way in.
  const existing = await PlatformUser.countDocuments();
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

module.exports = { seedOwnerFromEnv };
