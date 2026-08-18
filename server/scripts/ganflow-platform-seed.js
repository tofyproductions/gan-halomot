#!/usr/bin/env node
/**
 * Create the first console account. Run once, on a fresh control plane.
 *
 *   PLATFORM_MONGODB_URI="..." node scripts/ganflow-platform-seed.js \
 *     --email you@example.com --name "עמית" --password "..."
 */
const bcrypt = require('bcryptjs');
require('dotenv').config();
const { controlPlane, closeAll } = require('../src/platform/connection');

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(`--${n}`); return i === -1 ? null : argv[i + 1]; };

(async () => {
  if (!process.env.PLATFORM_MONGODB_URI) {
    console.error('\n❌  חסר PLATFORM_MONGODB_URI\n'); process.exit(1);
  }
  const email = (opt('email') || '').toLowerCase().trim();
  const password = opt('password');
  if (!email || !password) { console.error('\n❌  צריך --email ו---password\n'); process.exit(1); }
  if (password.length < 10) { console.error('\n❌  סיסמה קצרה מדי — לפחות 10 תווים\n'); process.exit(1); }

  const { PlatformUser } = await controlPlane();
  if (await PlatformUser.findOne({ email })) { console.error('\n❌  המשתמש כבר קיים\n'); process.exit(1); }

  await PlatformUser.create({
    email, full_name: opt('name') || '', role: 'owner',
    password_hash: await bcrypt.hash(password, 12),
  });
  console.log(`\n✅  נוצר משתמש קונסולה: ${email} (בעלים)\n`);
  await closeAll();
})().catch((e) => { console.error(e); process.exit(1); });
