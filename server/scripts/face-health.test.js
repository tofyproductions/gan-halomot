/**
 * The alert that catches a silence.
 *
 * Face recognition's likeliest failure produces no error: the queue jams, and
 * from outside, nothing happens. Photographs upload, the gallery works,
 * parents assume their child was not photographed. So the rules below are the
 * only thing standing between a stuck queue and three unnoticed weeks — and
 * equally, the only thing stopping a daily false alarm, which would be filtered
 * and then the real one would be filtered with it.
 */
const assert = require('assert');
const path = require('path');

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

const hoursAgo = (h) => new Date(Date.now() - h * 3600000);

(async () => {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'face_health' });

  // The scanner's health reading is the input under test, so it is stubbed
  // rather than driven — building a genuinely stuck queue would mean scanning
  // real photographs to make a test about not scanning them.
  const scannerPath = require.resolve('../src/services/face/scanner');
  let reading = {};
  require.cache[scannerPath] = {
    id: scannerPath, filename: scannerPath, loaded: true, children: [], paths: [],
    exports: { health: async () => reading, ENABLED_KEY: 'face_recognition_enabled' },
  };

  // Email must not actually go anywhere from a test.
  const emailPath = require.resolve('../src/services/email.service');
  const sent = [];
  require.cache[emailPath] = {
    id: emailPath, filename: emailPath, loaded: true, children: [], paths: [],
    exports: { dispatchEmail: async (m) => { sent.push(m); return { ok: true }; } },
  };

  const job = require('../src/services/faceHealthJob');
  const { Setting } = require('../src/models');
  await Setting.updateOne(
    { key: job.ALERT_KEY },
    { $set: { key: job.ALERT_KEY, value: { email: 'amit@example.com' } } },
    { upsert: true },
  );
  const clearMemory = () => Setting.deleteOne({ key: 'face_alert_last_sent' });

  console.log('face health alert:');

  reading = { enabled: false, pending: 500, failed: 0, last_scan_at: hoursAgo(99) };
  let r = await job.tick();
  check('switched off is not an alarm', r.ok && r.reason === 'off');
  check('  and sends nothing', sent.length === 0);

  reading = { enabled: true, pending: 0, failed: 0, last_scan_at: hoursAgo(99) };
  r = await job.tick();
  check('an empty queue is fine however long it has been idle', r.ok);
  check('  and sends nothing', sent.length === 0);

  reading = { enabled: true, pending: 40, failed: 0, last_scan_at: hoursAgo(0.2) };
  r = await job.tick();
  check('a busy afternoon is not an alarm', r.ok && r.reason === 'working');
  check('  and sends nothing', sent.length === 0);

  reading = { enabled: true, pending: 40, failed: 0, last_scan_at: hoursAgo(9) };
  r = await job.tick();
  check('work waiting and nothing scanned for hours DOES alert', r.alerted === true);
  check('  one message went out', sent.length === 1, `got ${sent.length}`);
  check('  to the configured address', sent[0] && sent[0].to === 'amit@example.com');
  check('  saying how many are stuck', Boolean(sent[0] && sent[0].subject.includes('40')));

  r = await job.tick();
  check('it does not repeat within the day', !r.alerted && r.reason === 'already told');
  check('  still one message', sent.length === 1, `got ${sent.length}`);

  await Setting.updateOne(
    { key: 'face_alert_last_sent' },
    { $set: { value: { at: hoursAgo(30) } } },
  );
  r = await job.tick();
  check('but it does remind the next day', r.alerted === true);
  check('  two messages now', sent.length === 2, `got ${sent.length}`);

  await clearMemory();
  await Setting.updateOne({ key: job.ALERT_KEY }, { $set: { value: { email: '' } } });
  delete process.env.FACE_ALERT_EMAIL;
  r = await job.tick();
  check('no address configured is reported, not swallowed', r.reason === 'no recipient');
  check('  and nothing is sent', sent.length === 2, `got ${sent.length}`);

  await mongoose.disconnect();
  await mongod.stop();

  if (failures.length) {
    console.error(`\nFAIL face-health — ${failures.length} wrong`);
    process.exit(1);
  }
  console.log('\nPASS face-health');
  process.exit(0);
})().catch((e) => { console.error('FAIL face-health:', e); process.exit(1); });
