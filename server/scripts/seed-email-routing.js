/**
 * One-time: write the owner's agreed defaults into Setting `email_routing`
 * (docs/superpowers/specs/2026-09-27-email-routing-and-contact-design.md).
 *
 *   node scripts/seed-email-routing.js            dry run — prints what it would write
 *   node scripts/seed-email-routing.js --apply    writes (refuses if the Setting exists)
 *   node scripts/seed-email-routing.js --apply --force   overwrites
 *
 * server/.env points at PRODUCTION. After the seed the admin grid owns it.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { User, Setting } = require('../src/models');
const R = require('../src/services/office-recipients.service');

const PEOPLE = {
  ben: 'totofy10@gmail.com',
  amit: 'tofy10.amit@gmail.com',
  orly: 'tofy10.office@gmail.com',
  elad: 'sharvit82@gmail.com',
};
const DEFAULTS = {
  system_faults: ['amit', 'ben'],
  hr: ['orly', 'ben', 'elad'],
  parents_finance: ['ben', 'orly'],
  contact_tech: ['amit', 'ben'],
  contact_graphics: ['amit', 'ben'],
  contact_payroll: ['orly', 'ben', 'elad'],
  contact_general: ['ben'],
};

(async () => {
  const apply = process.argv.includes('--apply');
  const force = process.argv.includes('--force');
  await mongoose.connect(process.env.MONGODB_URI);

  const ids = {};
  for (const [who, email] of Object.entries(PEOPLE)) {
    const u = await User.findOne({ email, is_active: { $ne: false } }).select('_id full_name role').lean();
    if (!u) throw new Error(`no live user with ${email} (${who}) — aborting, nothing written`);
    ids[who] = String(u._id);
    console.log(`${who.padEnd(5)} → ${u.full_name} (${u.role})`);
  }
  const topics = {};
  for (const t of R.TOPICS) {
    topics[t.key] = { user_ids: (DEFAULTS[t.key] || []).map(w => ids[w]), extra_emails: [] };
  }

  const existing = await Setting.findOne({ key: R.ROUTING_KEY }).lean();
  if (existing && !force) {
    console.log('\nSetting already exists — not touching it (use --force to overwrite).');
  } else if (!apply) {
    console.log('\nDRY RUN — would write:', JSON.stringify(topics, null, 2));
  } else {
    await Setting.findOneAndUpdate({ key: R.ROUTING_KEY }, { value: { topics } }, { upsert: true });
    console.log('\nwritten.');
  }
  console.log('\nresolved recipients now:');
  for (const t of R.TOPICS) console.log(`  ${t.key.padEnd(16)} ${(await R.officeEmails(t.key)).join(', ')}`);
  await mongoose.disconnect();
})().catch(async (e) => { console.error(e.message); await mongoose.disconnect(); process.exit(1); });
