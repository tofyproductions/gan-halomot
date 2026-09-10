#!/usr/bin/env node
/**
 * פנייה חדשה מהורה — תודה אוטומטית להורה, מייל למנהל, וספירת "חדשות" לתג.
 *
 * מריץ שרת אמיתי מול מסד נתונים מקומי בזיכרון, ומדמה sms.service +
 * email.service (כך שהבדיקה לא תלויה ב-SMS_KEY/RESEND_API_KEY אמיתיים ולא
 * שולחת שום דבר החוצה) כדי לוודא: מי בדיוק קיבל מה, שכשלון בערוץ אחד לא עוצר
 * את השני ולא מפיל את השליחה של ההורה, ושמספר "החדשות" בתג נכון לפי הסניפים
 * שבניהול כל משתמש.
 *
 * THE DATABASE IS EPHEMERAL AND LOCAL — same three guarantees as
 * viewer-e2e.test.js (dotenv stubbed first, MONGODB_URI set before
 * src/index.js loads, host asserted loopback before any write).
 *
 *   node scripts/leads-notifications.test.js
 */
const net = require('net');
const http = require('http');

const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};

// Record every call instead of touching a real SMS/email provider.
const sent = { sms: [], email: [] };
const smsPath = require.resolve('../src/services/sms.service');
require.cache[smsPath] = {
  id: smsPath, filename: smsPath, loaded: true, children: [], paths: [],
  exports: {
    sendSms: async ({ to, text }) => {
      sent.sms.push({ to, text });
      if (to === '0599999999') throw new Error('simulated SMS provider failure');
      return { to, status: 1 };
    },
    normalizePhone: (v) => v, isConfigured: () => true, remainingBalance: async () => null,
  },
};
const emailPath = require.resolve('../src/services/email.service');
require.cache[emailPath] = {
  id: emailPath, filename: emailPath, loaded: true, children: [], paths: [],
  exports: {
    dispatchEmail: async ({ to, subject, html, text }) => {
      if (String(subject).includes('BAD')) throw new Error('simulated email provider failure');
      sent.email.push({ to: Array.isArray(to) ? to : [to], subject, html, text });
      return { ok: true };
    },
  },
};

const { MongoMemoryServer } = require('mongodb-memory-server');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

const PASSWORD = 'test1234';
let failures = 0;
let checks = 0;
function ok(cond, label, detail = '') {
  checks++;
  if (cond) console.log(`  ✅ ${label}`);
  else { failures++; console.log(`  ❌ ${label}${detail ? `  (${detail})` : ''}`); }
  return !!cond;
}
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), label, `קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)}`);
const head = (t) => console.log(`\n${t}`);

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
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
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: json, text });
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try { const r = await request({ path: '/api/health' }); if (r.status === 200) return true; } catch { /* not up */ }
    await sleep(200);
  }
  throw new Error('השרת לא ענה על /api/health');
}
async function login(full_name, id_number) {
  const r = await request({ method: 'POST', path: '/api/auth/login-password', body: { full_name, id_number, password: PASSWORD } });
  if (r.status !== 200 || !r.body?.token) throw new Error(`התחברות נכשלה עבור ${full_name}: ${r.status} ${r.text}`);
  return r.body.token;
}
async function waitFor(pred, tries = 30) {
  for (let i = 0; i < tries; i++) { if (pred()) return true; await sleep(50); }
  return pred();
}

let mongod = null;
let server = null;

async function main() {
  console.log('=== פניות הורים — תודה אוטומטית, מייל למנהל, תג "חדשות" ===');

  mongod = await MongoMemoryServer.create({ instance: { dbName: 'gan_leads_notify' } });
  PORT = await freePort();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_SECRET = 'leads-notify-secret';
  process.env.PARENT_SECRET = 'leads-notify-parent-secret';
  process.env.DISABLE_JOBS = '1';
  process.env.PORT = String(PORT);
  process.env.FRONTEND_URL = 'http://localhost:4173';
  process.env.NODE_ENV = 'development';
  process.env.GC_REEXEC = '1';
  delete process.env.PLATFORM_MONGODB_URI;

  const express = require('express');
  const originalListen = express.application.listen;
  express.application.listen = function patched(...args) { server = originalListen.apply(this, args); return server; };
  require('../src/index.js');
  await waitForServer();
  express.application.listen = originalListen;

  const host = String(mongoose.connection.host || '');
  if (!/^(127\.0\.0\.1|localhost|::1)$/.test(host)) throw new Error(`מסד הנתונים אינו מקומי (${host}) — עוצרים`);
  console.log(`\nשרת עלה על :${PORT}, מסד נתונים בזיכרון (${host})`);

  const { User, Branch } = require('../src/models');
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  const herzliya = await Branch.create({ name: 'הרצליה הרצוג' });
  const tania = await User.create({
    email: 'tania@leads.local', full_name: 'טניה מנהלת', id_number: '910000001',
    role: 'branch_manager', branch_id: herzliya._id, position: 'מנהלת סניף',
    password_hash: passwordHash, password_set: true, is_active: true,
  });
  const admin = await User.create({
    email: 'admin@leads.local', full_name: 'אורי מנהל', id_number: '910000002',
    role: 'system_admin', branch_id: herzliya._id, position: 'מנהל מערכת',
    password_hash: passwordHash, password_set: true, is_active: true,
  });
  const tokenTania = await login('טניה מנהלת', '910000001');
  const tokenAdmin = await login('אורי מנהל', '910000002');

  head('בדיקה 1 — פנייה עם טלפון+מייל: שני הערוצים מקבלים תודה, והמנהלת מקבלת מייל');
  {
    const res = await request({
      method: 'POST', path: '/api/public/lead',
      body: {
        parent_name: 'הורה לדוגמה', parent_phone: '0501234567', parent_email: 'parent@example.com',
        child_name: 'ילדה', branch_id: String(herzliya._id), message: 'מתי אפשר לבוא לביקור?',
      },
    });
    eq(res.status, 201, '1a הפנייה נקלטה');
    await waitFor(() => sent.sms.length >= 1 && sent.email.length >= 2);
    ok(sent.sms.some(s => s.to === '0501234567' && s.text.includes('תודה על פנייתכם')), '1b נשלח sms תודה להורה', JSON.stringify(sent.sms));
    ok(sent.email.some(e => e.to.includes('parent@example.com') && e.subject.includes('תודה')), '1c נשלח מייל תודה להורה', JSON.stringify(sent.email));
    ok(sent.email.some(e => e.to.includes('tania@leads.local') && e.subject.includes('פנייה חדשה')), '1d נשלח מייל למנהלת הסניף על הפנייה', JSON.stringify(sent.email));
  }

  head('בדיקה 2 — פנייה בלי מייל: sms תודה נשלח, אין ניסיון לשלוח מייל להורה');
  {
    sent.sms.length = 0; sent.email.length = 0;
    const res = await request({
      method: 'POST', path: '/api/public/lead',
      body: { parent_name: 'הורה בלי מייל', parent_phone: '0521112222', branch_id: String(herzliya._id) },
    });
    eq(res.status, 201, '2a הפנייה נקלטה');
    await waitFor(() => sent.sms.length >= 1);
    ok(sent.sms.some(s => s.to === '0521112222'), '2b sms תודה נשלח');
    ok(!sent.email.some(e => e.subject?.includes('תודה')), '2c ולא נשלח מייל תודה (אין כתובת)');
  }

  head('בדיקה 3 — כשל בערוץ אחד (sms) לא עוצר את השני (מייל) ולא מפיל את הבקשה');
  {
    sent.sms.length = 0; sent.email.length = 0;
    const res = await request({
      method: 'POST', path: '/api/public/lead',
      body: { parent_name: 'הורה עם sms כושל', parent_phone: '0599999999', parent_email: 'still@example.com', branch_id: String(herzliya._id) },
    });
    eq(res.status, 201, '3a הבקשה עדיין מצליחה למרות כשל ב-sms');
    await waitFor(() => sent.email.some(e => e.to.includes('still@example.com')));
    ok(sent.email.some(e => e.to.includes('still@example.com') && e.subject.includes('תודה')), '3b ומייל התודה בכל זאת נשלח');
  }

  head('בדיקה 4 — תג "חדשות": נספר לפי סטטוס new, בהיקף הסניפים של המשתמש');
  {
    const cTania = await request({ token: tokenTania, path: '/api/leads/counts' });
    const cAdmin = await request({ token: tokenAdmin, path: '/api/leads/counts' });
    eq(cTania.status, 200, '4a הספירה נטענת לטניה');
    ok(cTania.body.new >= 3, '4b טניה רואה את כל ה-new שבהרצליה (לפחות 3 מהבדיקות למעלה)', JSON.stringify(cTania.body));
    eq(cTania.body.new, cAdmin.body.new, '4c לסניף יחיד ומנהל מערכת יחיד — אותה ספירה');
  }

  head('בדיקה 5 — הרשימה חושפת הודעה ומקור, לא רק את השדות הישנים');
  {
    const withSource = await request({
      method: 'POST', path: '/api/public/lead',
      body: { parent_name: 'הורה עם מקור', parent_phone: '0533334444', branch_id: String(herzliya._id), source: 'facebook_ad_1', message: 'הודעה לבדיקה' },
    });
    eq(withSource.status, 201, '5a נקלטה');
    const list = await request({ token: tokenTania, path: '/api/leads' });
    const row = (list.body?.leads || []).find(l => l.parent_phone === '0533334444');
    ok(!!row, '5b הפנייה מופיעה ברשימה');
    eq(row?.source, 'facebook_ad_1', '5c ומחזירה את שדה המקור');
    eq(row?.message, 'הודעה לבדיקה', '5d ואת ההודעה החופשית');
  }

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} בדיקות עברו`);
}

main()
  .catch((err) => { console.error('\n💥', err); failures++; })
  .finally(async () => {
    try { if (server) await new Promise(r => server.close(r)); } catch { /* closing */ }
    try { await mongoose.disconnect(); } catch { /* disconnecting */ }
    try { if (mongod) await mongod.stop(); } catch { /* stopping */ }
    process.exit(failures === 0 ? 0 : 1);
  });
