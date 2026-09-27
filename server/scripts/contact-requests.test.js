/**
 * "פניות למשרד" — who sees which request, the status flow, and who is told
 * (docs/superpowers/specs/2026-09-27-email-routing-and-contact-design.md).
 *
 *   node scripts/contact-requests.test.js
 *
 * In-memory Mongo; email and the bucket are stubbed, so nothing leaves.
 */
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
const tick = () => new Promise(r => setTimeout(r, 50));

// Mail must not go anywhere from a test.
const mails = [];
const emailPath = require.resolve('../src/services/email.service');
require.cache[emailPath] = {
  id: emailPath, filename: emailPath, loaded: true, children: [], paths: [],
  exports: { dispatchEmail: async (m) => { mails.push(m); return { provider: 'test' }; } },
};
// No bucket: attachments go inline.
const storagePath = require.resolve('../src/services/storage.service');
require.cache[storagePath] = {
  id: storagePath, filename: storagePath, loaded: true, children: [], paths: [],
  exports: { isConfigured: () => false },
};

function call(handler, user, { body = {}, params = {}, query = {}, file = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = { user, body, params, query, file, headers: {} };
    const res = {
      statusCode: 200, headers: {},
      status(c) { this.statusCode = c; return this; },
      set(k, v) { this.headers[k] = v; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); },
      send(b) { resolve({ status: this.statusCode, body: b, headers: this.headers }); },
    };
    Promise.resolve(handler(req, res, reject)).catch(reject);
  });
}

(async () => {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'contact_requests' });
  const { User, Setting, NotificationEvent, ContactRequest } = require('../src/models');
  const R = require('../src/services/office-recipients.service');
  const C = require('../src/controllers/contactRequests.controller');

  const mk = (full_name, role, email) => User.create({ full_name, role, email, password_hash: 'x', is_active: true });
  const ben = await mk('בן', 'system_admin', 'ben@example.com');
  const amit = await mk('עמית', 'system_admin', 'amit@example.com');
  const orly = await mk('אורלי', 'accountant', 'orly@example.com');
  const elad = await mk('אלעד', 'admin_viewer', 'elad@example.com');
  const dana = await mk('דנה', 'teacher', '1@gan-halomot.local');
  const rina = await mk('רינה', 'teacher', '2@gan-halomot.local');
  const as = (u, extra = {}) => ({ id: String(u._id), role: u.role, full_name: u.full_name, ...extra });
  await Setting.create({
    key: R.ROUTING_KEY,
    value: { topics: {
      contact_tech: { user_ids: [String(amit._id), String(ben._id)], extra_emails: [] },
      contact_payroll: { user_ids: [String(orly._id), String(ben._id), String(elad._id)], extra_emails: [] },
      contact_general: { user_ids: [], extra_emails: [] },
    } },
  });

  console.log('create:');
  let r = await call(C.create, as(dana), { body: { text: 'שלום' } });
  check('no topic → 400', r.status === 400);
  r = await call(C.create, as(dana), { body: { topic: 'contact_tech', text: '   ' } });
  check('empty text → 400', r.status === 400);
  r = await call(C.create, as(dana), { body: { topic: 'contact_tech', text: 'x' }, file: { mimetype: 'image/heic', size: 10, buffer: Buffer.from('x') } });
  check('a non-image / HEIC file → 400 in Hebrew', r.status === 400 && /JPG/.test(r.body.error), JSON.stringify(r.body));
  mails.length = 0;
  const png = Buffer.from('89504e47', 'hex');
  r = await call(C.create, as(dana), { body: { topic: 'contact_tech', text: 'האפליקציה נתקעת במסך הנוכחות' }, file: { mimetype: 'image/png', size: png.length, buffer: png, originalname: 's.png' } });
  const reqId = r.body.id;
  check('created, open, sender side', r.status === 201 && r.body.status === 'open' && r.body.side === 'sender', JSON.stringify(r.body));
  check('  the screenshot is recorded', r.body.messages[0].has_attachment === true);
  await tick();
  check('  one mail, to the tech topic (עמית + בן)', mails.length === 1 && same(mails[0].to.split(','), ['amit@example.com', 'ben@example.com']), JSON.stringify(mails.map(m => m.to)));
  let evs = await NotificationEvent.find({ type: 'contact_request_new', ref_id: reqId }).lean();
  check('  a repeating push to each routed person', same(evs.map(e => String(e.recipient_id)), [String(amit._id), String(ben._id)]) && evs.every(e => e.status === 'pending'));

  console.log('\nwho sees it:');
  r = await call(C.inbox, as(amit), { query: {} });
  check('עמית (tech) sees it in the inbox', r.body.requests.length === 1 && r.body.requests[0].side === 'office');
  r = await call(C.counts, as(amit));
  check('  and it counts on his badge', r.body.open === 1);
  r = await call(C.inbox, as(orly), { query: {} });
  check('אורלי (payroll only) does not', r.body.requests.length === 0);
  r = await call(C.getOne, as(orly), { params: { id: reqId } });
  check('  not even by id', r.status === 404);
  r = await call(C.getOne, as(rina), { params: { id: reqId } });
  check('another teacher cannot open it', r.status === 404);
  r = await call(C.mine, as(dana));
  check('the sender sees it under "mine"', r.body.requests.length === 1);

  console.log('\norphan topic (nobody routed on "כללי"):');
  r = await call(C.create, as(rina), { body: { topic: 'contact_general', text: 'שאלה כללית' } });
  const generalId = r.body.id;
  r = await call(C.inbox, as(ben), { query: {} });
  check('a system admin sees it', r.body.requests.some(x => x.id === generalId));
  r = await call(C.inbox, as(elad, { role: 'system_admin', actual_role: 'admin_viewer' }), { query: {} });
  check('a viewer read (role swapped to system_admin) does NOT', !r.body.requests.some(x => x.id === generalId));
  check('  but sees her own routed topic list', r.body.topics.map(t => t.key).join() === 'contact_payroll');

  console.log('\nconversation:');
  r = await call(C.reply, as(amit), { params: { id: reqId }, body: { text: 'תנסי לרענן את האפליקציה' } });
  check('office reply → answered', r.status === 200 && r.body.status === 'answered' && r.body.messages.length === 2, JSON.stringify(r.body));
  await tick();
  evs = await NotificationEvent.find({ type: 'contact_request_new', ref_id: reqId }).lean();
  check('  the office pushes stop', evs.every(e => e.status === 'resolved'));
  const rep = await NotificationEvent.findOne({ type: 'contact_request_reply', ref_id: reqId }).lean();
  check('  the sender gets ONE push', rep && String(rep.recipient_id) === String(dana._id) && rep.status === 'resolved');
  const stored = await ContactRequest.findById(reqId).lean();
  check('  the first message kept its screenshot bytes', !!stored.messages[0].attachment?.data);
  mails.length = 0;
  r = await call(C.reply, as(dana), { params: { id: reqId }, body: { text: 'עדיין לא עובד' } });
  check('sender reply → open again', r.body.status === 'open');
  await tick();
  check('  and the office is mailed again', mails.length === 1 && /תגובה בפנייה/.test(mails[0].subject));
  r = await call(C.reply, as(orly), { params: { id: reqId }, body: { text: 'אני' } });
  check('someone off the topic cannot reply', r.status === 404);

  console.log('\nattachment:');
  r = await call(C.attachment, as(amit), { params: { id: reqId, i: '0' } });
  check('the routed office gets the bytes', Buffer.isBuffer(r.body) && r.body.equals(png) && r.headers['Content-Type'] === 'image/png');
  r = await call(C.attachment, as(orly), { params: { id: reqId, i: '0' } });
  check('  nobody else does', r.status === 404);

  console.log('\nclose:');
  r = await call(C.close, as(dana), { params: { id: reqId } });
  check('the sender closes it', r.body.status === 'closed');
  r = await call(C.reply, as(amit), { params: { id: reqId }, body: { text: 'עוד משהו' } });
  check('a closed thread takes no replies (409)', r.status === 409);
  r = await call(C.counts, as(amit));
  check('the badge drops it (only the orphan "כללי" one is left for a system admin)', r.body.open === 1, JSON.stringify(r.body));
  r = await call(C.inbox, as(amit), { query: { status: 'closed' } });
  check('the closed filter shows it', r.body.requests.length === 1);

  await mongoose.disconnect();
  await mongod.stop();
  if (failures.length) { console.log(`\n${failures.length} failed`); process.exit(1); }
  console.log('\nAll contact-requests tests passed.');
})().catch((err) => { console.error(err); process.exit(1); });
