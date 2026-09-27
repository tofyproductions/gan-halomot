/**
 * Office email routing — who in the office hears about which topic
 * (docs/superpowers/specs/2026-09-27-email-routing-and-contact-design.md).
 *
 *   node scripts/office-recipients.test.js
 *
 * Runs against an in-memory Mongo, so it never touches the real one.
 */
const assert = require('assert');

const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

const failures = [];
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

(async () => {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'office_recipients' });
  const { User, Setting } = require('../src/models');
  const R = require('../src/services/office-recipients.service');

  const mk = (full_name, role, email, extra = {}) => User.create({
    full_name, role, email, password_hash: 'x', is_active: true, ...extra,
  });
  const ben = await mk('בן', 'system_admin', 'Ben@Example.com');
  const amit = await mk('עמית', 'system_admin', 'amit@example.com');
  const orly = await mk('אורלי', 'accountant', 'orly@example.com');
  const elad = await mk('אלעד', 'admin_viewer', 'elad@example.com');
  const gone = await mk('עזבה', 'accountant', 'gone@example.com', { is_active: false });
  const test = await mk('בודק', 'system_admin', 'test@example.com', { is_test_account: true });
  const local = await mk('פנימי', 'accountant', '123456789@gan-halomot.local');
  await mk('ישן', 'system_admin', 'admin@ganhalomot.co.il');
  await mk('מורה', 'teacher', 'teacher@example.com');

  const route = (topics) => Setting.findOneAndUpdate(
    { key: R.ROUTING_KEY }, { value: { topics } }, { upsert: true },
  );

  console.log('topics:');
  check('seven topics, three mail + four contact',
    R.TOPICS.length === 7
      && R.TOPICS.filter(t => t.kind === 'mail').length === 3
      && R.TOPICS.filter(t => t.kind === 'contact').length === 4);
  check('an unknown topic throws', await R.officeEmails('nope').then(() => false, () => true));

  console.log('\nrouting:');
  await route({
    hr: { user_ids: [String(orly._id), String(ben._id), String(elad._id)], extra_emails: [] },
    system_faults: { user_ids: [String(amit._id), String(ben._id)], extra_emails: ['Einat@Example.com', 'orly@example.com'] },
    parents_finance: { user_ids: [String(gone._id), String(test._id), String(local._id)], extra_emails: ['bad-address'] },
  });
  let got = await R.officeEmails('hr');
  check('hr → exactly the routed people', same(got, ['orly@example.com', 'ben@example.com', 'elad@example.com']), JSON.stringify(got));
  got = await R.officeEmails('system_faults');
  check('extra addresses join, lower-cased, de-duplicated',
    same(got, ['amit@example.com', 'ben@example.com', 'einat@example.com', 'orly@example.com']), JSON.stringify(got));

  console.log('\nfilters + fallback:');
  got = await R.officeEmails('parents_finance');
  check('inactive / test / placeholder / invalid all dropped → fallback to live system_admins',
    same(got, ['ben@example.com', 'amit@example.com']), JSON.stringify(got));
  got = await R.officeEmails('contact_general');
  check('a topic nobody configured also falls back', same(got, ['ben@example.com', 'amit@example.com']), JSON.stringify(got));
  await Setting.deleteOne({ key: R.ROUTING_KEY });
  got = await R.officeEmails('hr');
  check('no Setting at all → fallback, never silence', same(got, ['ben@example.com', 'amit@example.com']), JSON.stringify(got));

  console.log('\nuser ids (push / visibility):');
  await route({ contact_tech: { user_ids: [String(amit._id), String(gone._id), 'not-an-id'], extra_emails: ['x@example.com'] } });
  const ids = await R.officeUserIds('contact_tech');
  check('only live routed users', same(ids, [String(amit._id)]), JSON.stringify(ids));
  check('no fallback for ids', (await R.officeUserIds('contact_general')).length === 0);

  console.log('\ncandidates:');
  const cands = (await R.candidates()).map(u => u.full_name);
  check('office roles with a real address, live only', same(cands, ['בן', 'עמית', 'אורלי', 'אלעד']), JSON.stringify(cands));

  console.log('\nisRealEmail:');
  assert.ok(R.isRealEmail('a@b.co'));
  check('rejects the two fake domains and junk',
    !R.isRealEmail('1@gan-halomot.local') && !R.isRealEmail('x@ganhalomot.co.il') && !R.isRealEmail('nope') && !R.isRealEmail(''));

  await mongoose.disconnect();
  await mongod.stop();
  if (failures.length) { console.log(`\n${failures.length} failed`); process.exit(1); }
  console.log('\nAll office-recipients tests passed.');
})().catch((err) => { console.error(err); process.exit(1); });
