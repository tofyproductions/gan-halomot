#!/usr/bin/env node
/**
 * The bank-pi agent's signed door, end to end, against the REAL server.
 * Ephemeral local Mongo; dotenv is stubbed so server/.env (production on this
 * machine) is never read; the connection host is asserted loopback.
 *
 *   node scripts/finance-agent-e2e.test.js
 */
const net = require('net');
const http = require('http');

/* Nothing may read server/.env. Stub dotenv before anything loads it. */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let failures = 0;
let checks = 0;

function ok(cond, label, detail = '') {
  checks++;
  if (cond) console.log(`  ✅ ${label}`);
  else { failures++; console.log(`  ❌ ${label}${detail ? `  (${detail})` : ''}`); }
  return !!cond;
}
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

function request({ method = 'GET', path, token, body, headers = {}, raw = false }) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    let payload = null;
    if (body !== undefined && body !== null) {
      if (Buffer.isBuffer(body)) payload = body;
      else {
        payload = Buffer.from(JSON.stringify(body));
        h['Content-Type'] = h['Content-Type'] || 'application/json';
      }
      h['Content-Length'] = payload.length;
    }
    if (token) h.Authorization = `Bearer ${token}`;
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (raw) return resolve({ status: res.statusCode, buffer: buf, headers: res.headers });
        const text = buf.toString('utf8');
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
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('השרת לא ענה על /api/health');
}


const crypto = require('crypto');
const KEY = 'k'.repeat(40);

let mongod = null;
let server = null;

function signed(path, body, { key = KEY, ts = Math.floor(Date.now() / 1000), tamper = false } = {}) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const sig = crypto.createHmac('sha256', key).update(`${ts}.${raw}`).digest('hex');
  return request({
    method: body === undefined ? 'GET' : 'POST', path,
    body: body === undefined ? undefined : Buffer.from(tamper ? raw.replace('-100', '-999') : raw),
    headers: { 'Content-Type': 'application/json', 'X-Finance-Key': key, 'X-Finance-Ts': String(ts), 'X-Finance-Sig': sig },
  });
}

const payload = { agent_version: 'test', accounts: [{
  external_id: 'beinleumi:••••0463', institution: 'beinleumi', label: 'בינלאומי ••••0463', type: 'bank', balance: 5,
  transactions: [{ date: '2026-09-10', amount: -100, description: 'ספק', bank_ref: '1' }],
}] };

async function main() {
  console.log('=== דלת הסוכן של הבנק — בדיקת קצה-אל-קצה ===');
  mongod = await MongoMemoryServer.create({ instance: { dbName: 'gan_financeagent_e2e' } });
  PORT = await freePort();

  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_SECRET = 'financeagent-e2e-secret';
  process.env.PARENT_SECRET = 'financeagent-e2e-parent-secret';
  process.env.FINANCE_INGEST_KEY = KEY;
  process.env.DISABLE_JOBS = '1';
  process.env.PORT = String(PORT);
  process.env.FRONTEND_URL = 'http://localhost:4173';
  process.env.NODE_ENV = 'development';
  process.env.GC_REEXEC = '1';
  delete process.env.PLATFORM_MONGODB_URI;

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

  head('חתימה');
  eq((await signed('/api/finance/agent/ingest', payload)).status, 200, 'חתימה תקינה — נקלט');
  eq((await signed('/api/finance/agent/ingest', payload, { key: 'x'.repeat(40) })).status, 401, 'מפתח זר — נדחה');
  eq((await signed('/api/finance/agent/ingest', payload, { ts: Math.floor(Date.now() / 1000) - 3600 })).status, 401, 'חותמת זמן ישנה — נדחה');
  eq((await signed('/api/finance/agent/ingest', payload, { tamper: true })).status, 401, 'גוף ששונה בדרך — נדחה');
  const noAuth = await request({ method: 'POST', path: '/api/finance/agent/ingest', body: payload });
  eq(noAuth.status, 401, 'בלי כותרות — נדחה');

  head('קלט');
  const { FinanceSyncRequest, BankTransaction } = require('../src/models');
  eq(await BankTransaction.countDocuments(), 1, 'תנועה אחת נקלטה פעם אחת');
  const bad = await signed('/api/finance/agent/ingest', { agent_version: 'test', accounts: 'לא מערך' });
  eq(bad.status, 400, 'גוף פגום — 400');

  head('תור סנכרון');
  eq((await signed('/api/finance/agent/sync/claim')).body?.id, null, 'אין בקשה — id ריק');
  const req1 = await FinanceSyncRequest.create({});
  const claimed = await signed('/api/finance/agent/sync/claim');
  eq(claimed.body?.id, String(req1._id), 'בקשה ממתינה נמסרה');
  eq((await signed('/api/finance/agent/sync/claim')).body?.id, null, 'ולא נמסרת פעמיים');
  await signed('/api/finance/agent/sync/finish', { id: claimed.body.id, ok: true, result: 'ok' });
  eq((await FinanceSyncRequest.findById(req1._id).lean()).status, 'done', 'סיום נרשם');

  head('הדלת סגורה בלי מפתח');
  delete process.env.FINANCE_INGEST_KEY;
  require('../src/config/env').FINANCE_INGEST_KEY = undefined;
  eq((await signed('/api/finance/agent/ingest', payload)).status, 503, 'בלי מפתח מוגדר — הדלת סגורה');

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
