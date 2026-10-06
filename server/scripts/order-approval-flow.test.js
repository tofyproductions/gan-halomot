#!/usr/bin/env node
/**
 * Nobody emails a supplier without the office saying so.
 *
 * Until now an order went to the supplier the moment whoever built it pressed
 * send — there was no approval anywhere, and the two states in the model that
 * look like one (`approved`, `sent`) were dead: nothing ever produced them,
 * and `approve` flipped a flag without sending anything. Meanwhile the one
 * person who actually walks the building and knows the light bulbs ran out —
 * the אב בית, carried in the system as a teacher — could not build an order at
 * all. He got 403 from requireRole and that was the end of it.
 *
 * So: everyone who can build an order can now build one, nobody's send
 * reaches the supplier, and approving IS the sending. These checks are the
 * wall around that sentence.
 *
 * The interesting one is check 5. `admin_viewer` is the read-only role — the
 * database itself refuses its writes (utils/viewerWriteGuard) unless a gate
 * has deliberately claimed the request — and the gan wants that role to
 * approve orders anyway. So it is not enough to see a 200: the test reads the
 * order back and asserts the write actually landed, because a viewer write
 * that is quietly turned into a proposal also answers 200.
 *
 * THE DATABASE IS EPHEMERAL AND LOCAL. dotenv is stubbed out of require.cache
 * before anything loads it, so server/.env — which on this machine points at
 * production — is never read, and the connection host is asserted to be
 * loopback before a single document is written.
 *
 *   node scripts/order-approval-flow.test.js
 */
const net = require('net');
const http = require('http');

const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};

const { MongoMemoryServer } = require('mongodb-memory-server');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

const PASSWORD = 'test1234';
let failures = 0;
let checks = 0;

const ok = (cond, label, detail = '') => {
  checks++;
  if (cond) console.log(`  ✅ ${label}`);
  else { failures++; console.log(`  ❌ ${label}${detail ? `  (${detail})` : ''}`); }
  return !!cond;
};
const eq = (a, b, label) => ok(a === b, label, `קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)}`);
const head = (t) => console.log(`\n${t}`);

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

let PORT = 0;

function request({ method = 'GET', path, token, body }) {
  return new Promise((resolve, reject) => {
    const h = {};
    let payload = null;
    if (body !== undefined && body !== null) {
      payload = Buffer.from(JSON.stringify(body));
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = payload.length;
    }
    if (token) h.Authorization = `Bearer ${token}`;
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: json, text });
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await request({ path: '/api/health' });
      if (r.status === 200) return true;
    } catch { /* not up */ }
    await sleep(200);
  }
  throw new Error('השרת לא ענה על /api/health');
}

let mongod = null;
let server = null;

async function main() {
  console.log('=== הזמנות — מסלול האישור ===');

  mongod = await MongoMemoryServer.create({ instance: { dbName: 'gan_order_approval' } });
  PORT = await freePort();

  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_SECRET = 'order-approval-secret';
  process.env.DISABLE_JOBS = '1';
  process.env.PORT = String(PORT);
  process.env.FRONTEND_URL = 'http://localhost:4173';
  process.env.NODE_ENV = 'development';
  process.env.GC_REEXEC = '1';
  delete process.env.PLATFORM_MONGODB_URI;
  // No SMTP on purpose: a dispatch that cannot post the letter must still
  // move the order, and these checks are about the state machine.
  delete process.env.SMTP_USER;

  const express = require('express');
  const originalListen = express.application.listen;
  express.application.listen = function patched(...args) {
    server = originalListen.apply(this, args);
    return server;
  };
  require('../src/index.js');
  await waitForServer();
  express.application.listen = originalListen;

  const host = String(mongoose.connection.host || '');
  if (!/^(127\.0\.0\.1|localhost|::1)$/.test(host)) {
    throw new Error(`מסד הנתונים אינו מקומי (${host}) — עוצרים`);
  }
  console.log(`\nשרת עלה על :${PORT}, מסד נתונים בזיכרון (${host})`);

  const { User, Branch, Supplier, Product, Order } = require('../src/models');
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  const ks = await Branch.create({ name: 'כפר סבא - משה דיין', address: 'משה דיין 9' });
  const tlv = await Branch.create({ name: 'תל אביב', address: 'יפו 1' });

  const supplier = await Supplier.create({
    name: 'ספק הבדיקה', email: 'supplier@example.test', min_order_amount: 0,
  });
  const product = await Product.create({
    supplier_id: supplier._id, name: 'נורה', sku: 'BULB-1',
    price_before_vat: 10, price_with_vat: 11.7,
  });

  const mkUser = (o) => User.create({
    password_hash: passwordHash, password_set: true, is_active: true, ...o,
  });
  // הנרי, אב בית — carried as a teacher because the system has no better
  // role for him, and that is exactly why he was locked out.
  await mkUser({
    email: 'henry@test.local', full_name: 'הנרי אביב', id_number: '900000010',
    role: 'teacher', branch_id: ks._id, managed_branch_ids: [ks._id], position: 'אב בית',
  });
  await mkUser({
    email: 'mgr@test.local', full_name: 'לידור כהן', id_number: '900000011',
    role: 'branch_manager', branch_id: ks._id, managed_branch_ids: [ks._id],
  });
  await mkUser({
    email: 'admin@test.local', full_name: 'אורי מנהל', id_number: '900000012',
    role: 'system_admin', branch_id: ks._id,
  });
  await mkUser({
    email: 'viewer@test.local', full_name: 'רונית צופה', id_number: '900000013',
    role: 'admin_viewer', branch_id: ks._id,
  });

  const login = async (full_name, id_number) => {
    const r = await request({
      method: 'POST', path: '/api/auth/login-password',
      body: { full_name, id_number, password: PASSWORD },
    });
    if (r.status !== 200 || !r.body?.token) throw new Error(`התחברות נכשלה (${full_name}): ${r.status} ${r.text}`);
    return r.body.token;
  };

  const henry = await login('הנרי אביב', '900000010');
  const manager = await login('לידור כהן', '900000011');
  const admin = await login('אורי מנהל', '900000012');
  const viewer = await login('רונית צופה', '900000013');

  const newOrder = (token, branch = ks) => request({
    method: 'POST', path: '/api/orders', token,
    body: {
      branch_id: String(branch._id), supplier_id: String(supplier._id),
      items: [{ product_id: String(product._id), sku: product.sku, name: product.name, qty: 2, unit_price: product.price_with_vat }],
      notes: '',
    },
  });

  /* ---------------------------------------------------------------- */
  head('1. אב הבית בונה הזמנה');
  const created = await newOrder(henry);
  eq(created.status, 201, 'הנרי יוצר הזמנה — מותר לו');
  const orderId = created.body?.order?.id || created.body?.order?._id;
  ok(!!orderId, 'וההזמנה נוצרה');
  eq(created.body?.order?.status, 'awaiting_approval', 'והיא ממתינה לאישור — לא נשלחה לספק');

  const fresh = orderId ? await Order.findById(orderId).lean() : null;
  eq(fresh?.sent_at ?? null, null, 'ולא נרשם עליה שנשלחה');

  head('2. הוא גם עורך אותה כל עוד היא ממתינה');
  const edited = await request({
    method: 'PUT', path: `/api/orders/${orderId}`, token: henry,
    body: { notes: 'צריך דחוף' },
  });
  eq(edited.status, 200, 'עריכה עוברת');
  eq((await Order.findById(orderId).lean()).notes, 'צריך דחוף', 'והשינוי נשמר');

  head('3. אבל הוא לא מאשר');
  eq((await request({
    method: 'POST', path: `/api/orders/${orderId}/approve`, token: henry,
  })).status, 403, 'הנרי מנסה לאשר — נדחה');
  eq((await Order.findById(orderId).lean()).status, 'awaiting_approval', 'וההזמנה לא זזה');

  head('4. וגם מנהל סניף כבר לא שולח לספק בעצמו');
  const mgrOrder = await newOrder(manager);
  eq(mgrOrder.status, 201, 'מנהל סניף יוצר הזמנה');
  eq(mgrOrder.body?.order?.status, 'awaiting_approval', 'וגם היא ממתינה לאישור');
  eq((await request({
    method: 'POST', path: `/api/orders/${mgrOrder.body.order.id || mgrOrder.body.order._id}/approve`, token: manager,
  })).status, 403, 'והוא אינו מאשר אותה בעצמו');

  head('5. מנהל־לצפייה מאשר — והאישור באמת נכתב');
  const approved = await request({
    method: 'POST', path: `/api/orders/${orderId}/approve`, token: viewer,
  });
  eq(approved.status, 200, 'האישור עובר');
  const afterApprove = await Order.findById(orderId).lean();
  // THE CHECK THAT MATTERS. A viewer write that the guard turned into a
  // proposal also answers 200 — only the document says which happened.
  eq(afterApprove.status, 'pending', 'וההזמנה יצאה לספק בפועל');
  ok(!!afterApprove.approved_at, 'ונרשם מתי אושרה');
  eq(afterApprove.approved_by, 'רונית צופה', 'ועל ידי מי');

  head('6. אישור פעמיים');
  eq((await request({
    method: 'POST', path: `/api/orders/${orderId}/approve`, token: admin,
  })).status, 400, 'הזמנה שכבר אושרה אינה מאושרת שוב');

  head('7. מנהל מערכת מאשר');
  const second = await newOrder(henry);
  const secondId = second.body.order.id || second.body.order._id;
  eq((await request({
    method: 'POST', path: `/api/orders/${secondId}/approve`, token: admin,
  })).status, 200, 'מנהל מערכת מאשר');
  eq((await Order.findById(secondId).lean()).status, 'pending', 'וההזמנה יצאה');

  head('8. סניף אחר');
  const outside = await newOrder(henry, tlv);
  // הנרי is scoped to כפר סבא only; תל אביב is not his to order for.
  ok(outside.status === 403 || outside.status === 400,
    `הזמנה לסניף שאינו שלו נדחית (${outside.status})`);

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} עברו\n`);
}

main()
  .catch((err) => { console.error('\n❌ נפילה:', err); failures++; })
  .finally(async () => {
    try { if (server) await new Promise(r => server.close(r)); } catch { /* ignore */ }
    try { await mongoose.disconnect(); } catch { /* ignore */ }
    try { if (mongod) await mongod.stop(); } catch { /* ignore */ }
    process.exit(failures === 0 ? 0 : 1);
  });
