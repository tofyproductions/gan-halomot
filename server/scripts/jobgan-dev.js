// Dev harness: in-memory mongo + the real jobgan server + a couple of seeded ads.
const { MongoMemoryServer } = require('mongodb-memory-server');
const { spawn } = require('child_process');
const path = require('path');
const PORT = 5480;
const ADMIN = 'jobgan-admin-secret-for-dev-x';

(async () => {
  const mongo = await MongoMemoryServer.create({ instance: { port: 47017 } });
  const uri = `${mongo.getUri()}jobgan_dev`;
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'jobgan', 'index.js')], {
    env: { ...process.env, JOBGAN_MONGODB_URI: uri, JOBGAN_JWT_SECRET: 'dev-secret-at-least-16-chars',
           JOBGAN_ADMIN_SECRET: ADMIN, JOBGAN_PORT: String(PORT), NODE_ENV: 'development', MONGODB_URI: '' },
    stdio: 'inherit',
  });
  const B = `http://localhost:${PORT}`;
  const api = async (p, o = {}) => {
    const h = { 'Content-Type': 'application/json', ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}), ...(o.admin ? { 'x-jobgan-admin': ADMIN } : {}) };
    const r = await fetch(B + p, { method: o.method || 'GET', headers: h, body: o.body ? JSON.stringify(o.body) : undefined });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const wait = async () => { for (let i = 0; i < 100; i++) { try { if ((await fetch(`${B}/api/health`)).ok) return true; } catch {} await new Promise(r => setTimeout(r, 300)); } };
  await wait();
  const soon = d => new Date(Date.now() + d * 864e5).toISOString();
  const e1 = await api('/api/employers/register', { method: 'POST', body: { gan_name: 'גן פעמונים', contact_name: 'רותי לוי', contact_phone: '0521234567', email: 'a@x.invalid', password: 'Secret2026!' } });
  const t1 = e1.json.token;
  const mk = (b) => api('/api/employers/jobs', { method: 'POST', token: t1, body: b });
  const j1 = await mk({ title: 'גננת לגן פרטי', area: 'sharon', role: 'ganenet', scope: 'full', city: 'כפר סבא', salary_min: 48, salary_max: 58, salary_unit: 'hourly', starts_on: soon(21), description: 'גן חם ומשפחתי, צוות קבוע, 22 ילדים.' });
  await api(`/api/admin/jobs/${j1.json.job._id}/approve`, { method: 'POST', admin: true });
  await mk({ title: 'סייעת לגן עירוני', area: 'sharon', role: 'sayaat', scope: 'partial', city: 'הוד השרון', salary_min: 42, salary_max: 47, salary_unit: 'hourly', starts_on: soon(10) });
  const e2 = await api('/api/employers/register', { method: 'POST', body: { gan_name: 'גן שקד', contact_name: 'דנה', contact_phone: '0501112233', email: 'b@x.invalid', password: 'Secret2026!' } });
  const j3 = await api('/api/employers/jobs', { method: 'POST', token: e2.json.token, body: { title: 'מנהלת גן', area: 'gush_dan', role: 'manager', scope: 'full', city: 'רמת גן', salary_min: 12000, salary_max: 15000, salary_unit: 'monthly', starts_on: soon(45), description: 'ניהול גן ותיק עם צוות של שמונה.' } });
  await api(`/api/admin/jobs/${j3.json.job._id}/approve`, { method: 'POST', admin: true });
  console.log(`\n>>> ${B}  (מוכן)\n`);
  process.on('SIGTERM', () => { srv.kill(); mongo.stop(); });
})();
