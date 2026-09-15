#!/usr/bin/env node
/**
 * ג׳וב חלום, end to end, through the real HTTP stack.
 *
 * Starts the service the way Render starts it, against a throwaway database,
 * and drives the whole journey over the wire: a gan signs up, publishes,
 * waits for review; a woman signs up, finds the job, applies; the gan is
 * notified, opens, answers. Then the promises get tested rather than assumed —
 * the ones that are easy to write down and easy to break.
 *
 * `node --check` is not enough here and never was: it reads syntax and runs
 * nothing, and a config line that parses fine can still take the server down
 * on boot. This boots it.
 *
 *   npm install --no-save mongodb-memory-server
 *   node scripts/jobgan-e2e.test.js
 */
try { require.resolve('mongodb-memory-server'); } catch {
  console.error('\n❌  חסרה חבילת הבדיקה. הרץ:\n\n   npm install --no-save mongodb-memory-server\n');
  process.exit(1);
}

const { MongoMemoryServer } = require('mongodb-memory-server');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 5431;
const B = `http://localhost:${PORT}`;
const ADMIN_SECRET = 'jobgan-admin-secret-for-tests';
let failures = 0;
let checks = 0;

function ok(cond, label, detail = '') {
  checks++;
  console.log(`  ${cond ? '✅' : '❌'} ${label}${!cond && detail ? `\n     ${detail}` : ''}`);
  if (!cond) failures++;
}
const eq = (got, want, label) => ok(got === want, label, `קיבלנו ${JSON.stringify(got)}, ציפינו ${JSON.stringify(want)}`);

async function api(pathname, { method = 'GET', body, token, admin } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (admin) headers['x-jobgan-admin'] = ADMIN_SECRET;
  const res = await fetch(B + pathname, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, json };
}

const waitFor = async (fn, ms = 40000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if (await fn()) return true; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
};

const soon = (days) => new Date(Date.now() + days * 86400000).toISOString();

(async () => {
  const mongo = await MongoMemoryServer.create();
  // The guard demands "jobgan" in the database name — including here.
  const uri = `${mongo.getUri()}jobgan_test`;

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'jobgan', 'index.js')], {
    env: {
      ...process.env,
      JOBGAN_MONGODB_URI: uri,
      JOBGAN_JWT_SECRET: 'jobgan-test-secret-at-least-16',
      JOBGAN_ADMIN_SECRET: ADMIN_SECRET,
      JOBGAN_PORT: String(PORT),
      NODE_ENV: 'development',
      MONGODB_URI: '',
    },
    stdio: 'ignore',
  });

  const stop = async () => {
    server.kill('SIGTERM');
    await mongo.stop().catch(() => {});
  };

  try {
    const up = await waitFor(async () => (await fetch(`${B}/api/health`)).ok);
    if (!up) { console.error('\n❌  השרת לא עלה\n'); await stop(); process.exit(1); }
    console.log('\n--- השרת עלה ---');
    const health = await api('/api/health');
    eq(health.json.service, 'jobgan', 'השירות מזהה את עצמו');

    console.log('\n--- הרשימות הסגורות ---');
    const meta = await api('/api/meta');
    eq(meta.json.areas.length, 6, 'שישה אזורים');
    eq(meta.json.roles.length, 7, 'שבעה תפקידים');

    console.log('\n--- גן נרשם ---');
    const reg = await api('/api/employers/register', {
      method: 'POST',
      body: {
        gan_name: 'גן פעמונים', contact_name: 'רותי לוי', contact_phone: '0521234567',
        email: 'ganei@example.invalid', business_id: '580123456', password: 'Secret2026!',
      },
    });
    eq(reg.status, 201, 'הגן נרשם');
    const employerToken = reg.json.token;
    eq(reg.json.employer.status, 'pending', 'ומסומן כממתין לבדיקה');
    eq(reg.json.employer.is_customer, false, 'ואינו לקוח חלום');
    eq(reg.json.employer.max_tier, 1, 'ולכן תקרת המסלול היא 1');
    ok(/שלושה ימי עסקים/.test(reg.json.notice || ''), 'ונאמר לו מראש שהמודעה הראשונה נבדקת');

    const dup = await api('/api/employers/register', {
      method: 'POST',
      body: { gan_name: 'אחר', contact_name: 'א', contact_phone: '0521234567', email: 'ganei@example.invalid', password: 'Secret2026!' },
    });
    eq(dup.status, 409, 'אימייל כפול נדחה');

    console.log('\n--- ולידציה של מודעה ---');
    const noSalary = await api('/api/employers/jobs', {
      method: 'POST', token: employerToken,
      body: { title: 'גננת', area: 'sharon', role: 'ganenet', scope: 'full', salary_unit: 'hourly', starts_on: soon(14) },
    });
    eq(noSalary.status, 400, '⚠️  מודעה בלי טווח שכר נדחית');
    ok(/שכר/.test(noSalary.json.error || ''), 'וההודעה אומרת שזה השכר');

    const badArea = await api('/api/employers/jobs', {
      method: 'POST', token: employerToken,
      body: { title: 'גננת', area: 'תל אביב', role: 'ganenet', scope: 'full', salary_min: 45, salary_max: 55, salary_unit: 'hourly', starts_on: soon(14) },
    });
    eq(badArea.status, 400, 'אזור שאינו מהרשימה נדחה');

    console.log('\n--- סינון מודעה מפלה ---');
    const discriminatory = await api('/api/employers/jobs', {
      method: 'POST', token: employerToken,
      body: {
        title: 'דרושה גננת עד גיל 35', area: 'sharon', role: 'ganenet', scope: 'full',
        salary_min: 45, salary_max: 55, salary_unit: 'hourly', starts_on: soon(14),
      },
    });
    eq(discriminatory.json.blocked, true, '⚠️  מודעה עם דרישת גיל לא מתפרסמת');
    ok((discriminatory.json.grounds || []).includes('גיל'), 'והעילה נאמרת במפורש');
    ok(/לתקן/.test(discriminatory.json.message || ''), 'ומוצעת אפשרות לתקן ולא נדחית');

    console.log('\n--- מודעה תקינה מגן חדש ---');
    const created = await api('/api/employers/jobs', {
      method: 'POST', token: employerToken,
      body: {
        title: 'גננת לגן פרטי', area: 'sharon', role: 'ganenet', scope: 'full', city: 'כפר סבא',
        salary_min: 48, salary_max: 58, salary_unit: 'hourly', starts_on: soon(21),
        description: 'גן חם ומשפחתי, צוות קבוע.',
      },
    });
    eq(created.status, 201, 'המודעה נוצרה');
    eq(created.json.job.status, 'pending', 'וממתינה לבדיקה כי הגן חדש');
    const jobId = created.json.job._id;

    const boardBefore = await api('/api/jobs');
    eq(boardBefore.json.total, 0, '⚠️  ולא מופיעה בלוח הציבורי לפני אישור');

    console.log('\n--- תור האישור ---');
    const noAuth = await api('/api/admin/queue');
    eq(noAuth.status, 401, 'התור סגור בלי סוד ניהול');

    const queue = await api('/api/admin/queue', { admin: true });
    eq(queue.json.waiting, 2, 'בתור שתי מודעות (הממתינה והמסומנת)');

    const approved = await api(`/api/admin/jobs/${jobId}/approve`, { method: 'POST', admin: true });
    eq(approved.status, 200, 'המודעה אושרה');
    eq(approved.json.employer_activated, true, 'והגן הופעל, כך שהבאות יתפרסמו מיד');

    const boardAfter = await api('/api/jobs');
    eq(boardAfter.json.total, 1, 'והמודעה מופיעה בלוח');
    eq(boardAfter.json.ordering, 'relevance', '⚠️  והלוח מצהיר שהמיון לפי רלוונטיות');
    ok(!('contact_phone' in (boardAfter.json.jobs[0] || {})), '⚠️  ואין בלוח פרטי קשר של הגן');

    console.log('\n--- מודעה שנייה מאותו גן ---');
    const second = await api('/api/employers/jobs', {
      method: 'POST', token: employerToken,
      body: {
        title: 'סייעת', area: 'sharon', role: 'sayaat', scope: 'partial',
        salary_min: 40, salary_max: 45, salary_unit: 'hourly', starts_on: soon(30),
      },
    });
    eq(second.json.job.status, 'published', 'מתפרסמת מיד, בלי בדיקה חוזרת');

    const third = await api('/api/employers/jobs', {
      method: 'POST', token: employerToken,
      body: {
        title: 'טבחית', area: 'sharon', role: 'cook', scope: 'partial',
        salary_min: 40, salary_max: 45, salary_unit: 'hourly', starts_on: soon(30),
      },
    });
    eq(third.status, 402, 'מודעה שלישית חורגת מהמכסה החינמית');
    eq(third.json.code, 'FREE_TIER_LIMIT', 'עם קוד שאומר למה');

    console.log('\n--- עובדת נרשמת ומגישה ---');
    const seekerReg = await api('/api/seekers/register', {
      method: 'POST',
      body: {
        full_name: 'מיכל כהן', phone: '0549876543', password: 'Secret2026!',
        email: 'michal@example.invalid',
        areas: ['sharon'], roles: ['ganenet'], scope: 'full',
        available_from: soon(30), about: 'שלוש שנות ניסיון בגן פרטי.',
      },
    });
    eq(seekerReg.status, 201, 'העובדת נרשמה');
    const seekerToken = seekerReg.json.token;
    eq(seekerReg.json.seeker.completeness.filled, 7, 'והפרופיל שלם (7 מתוך 7)');

    const applied = await api(`/api/jobs/${jobId}/apply`, {
      method: 'POST', token: seekerToken, body: { message: 'אשמח לשמוע פרטים.' },
    });
    eq(applied.status, 201, 'המועמדות נשלחה');

    const again = await api(`/api/jobs/${jobId}/apply`, { method: 'POST', token: seekerToken });
    eq(again.status, 409, 'הגשה שנייה לאותה משרה נדחית');

    console.log('\n--- מה הגן רואה לפני שפתח ---');
    const inbox = await api('/api/employers/applications', { token: employerToken });
    eq(inbox.json.applications.length, 1, 'המועמדות בתיבה');
    const listed = inbox.json.applications[0];
    eq(listed.opened, false, 'ומסומנת כלא נפתחה');
    ok(!('full_name' in listed), '⚠️  ושם המועמדת אינו נחשף לפני פתיחה');
    ok(!('phone' in listed), '⚠️  וגם לא הטלפון');
    eq(listed.completeness.filled, 7, 'אבל שלמות הפרופיל כן מוצגת');

    console.log('\n--- פתיחה חושפת, ונרשמת ---');
    const opened = await api(`/api/employers/applications/${listed.id}/open`, { method: 'POST', token: employerToken });
    eq(opened.json.application.full_name, 'מיכל כהן', 'אחרי פתיחה השם נחשף');
    eq(opened.json.application.phone, '0549876543', 'וגם הטלפון');
    eq(opened.json.application.opened, true, 'והפתיחה נרשמה');

    console.log('\n--- בידוד בין גנים ---');
    const other = await api('/api/employers/register', {
      method: 'POST',
      body: { gan_name: 'גן אחר', contact_name: 'דנה', contact_phone: '0501112233', email: 'other@example.invalid', password: 'Secret2026!' },
    });
    const otherToken = other.json.token;
    const otherInbox = await api('/api/employers/applications', { token: otherToken });
    eq(otherInbox.json.applications.length, 0, '⚠️  גן אחר לא רואה את המועמדת');
    const steal = await api(`/api/employers/applications/${listed.id}/open`, { method: 'POST', token: otherToken });
    eq(steal.status, 404, '⚠️  ולא יכול לפתוח מועמדות שאינה שלו');

    console.log('\n--- אסימון של עובדת לא פותח דלת של גן ---');
    const wrongKind = await api('/api/employers/applications', { token: seekerToken });
    eq(wrongKind.status, 401, 'אסימון עובדת נדחה בנתיב של גן');
    const wrongKind2 = await api('/api/seekers/me', { token: employerToken });
    eq(wrongKind2.status, 401, 'ואסימון גן נדחה בנתיב של עובדת');

    console.log('\n--- שתי התשובות ---');
    const answered = await api(`/api/employers/applications/${listed.id}/answer`, {
      method: 'POST', token: employerToken, body: { status: 'invited' },
    });
    eq(answered.status, 200, 'הגן הזמין לראיון');
    const twice = await api(`/api/employers/applications/${listed.id}/answer`, {
      method: 'POST', token: employerToken, body: { status: 'rejected' },
    });
    eq(twice.status, 409, 'ותשובה שנייה נדחית');

    const mineNow = await api('/api/seekers/me/applications', { token: seekerToken });
    eq(mineNow.json.applications[0].status, 'invited', 'והעובדת רואה שהוזמנה');

    console.log('\n--- סגירת מודעה סוגרת מועמדויות פתוחות ---');
    const seeker2 = await api('/api/seekers/register', {
      method: 'POST',
      body: { full_name: 'שרה לוי', phone: '0533334444', password: 'Secret2026!', areas: ['sharon'], roles: ['sayaat'] },
    });
    const jobs2 = await api('/api/employers/jobs', { token: employerToken });
    const secondJobId = jobs2.json.jobs.find(j => j.title === 'סייעת')._id;
    await api(`/api/jobs/${secondJobId}/apply`, { method: 'POST', token: seeker2.json.token });

    const closed = await api(`/api/employers/jobs/${secondJobId}/close`, {
      method: 'POST', token: employerToken, body: { reason: 'filled' },
    });
    eq(closed.json.closed_applications, 1, '⚠️  סגירת המודעה סגרה את המועמדות שממתינה');
    const s2apps = await api('/api/seekers/me/applications', { token: seeker2.json.token });
    eq(s2apps.json.applications[0].status, 'job_closed', 'והעובדת רואה שהמשרה נסגרה ולא נשארת בלי תשובה');

    console.log('\n--- מחיקת חשבון ---');
    const del = await api('/api/seekers/me', { method: 'DELETE', token: seekerToken });
    eq(del.status, 200, 'החשבון נמחק');
    eq(del.json.applications_marked, 1, 'והמועמדות סומנה כבקשת מחיקה');
    ok(/עותק/.test(del.json.notice || ''), '⚠️  ונאמר לה במפורש שלגן יש עותק');

    const afterDelete = await api('/api/seekers/me', { token: seekerToken });
    eq(afterDelete.status, 404, 'והאסימון כבר לא מוצא חשבון');

    const employerSees = await api('/api/employers/applications', { token: employerToken });
    const marked = employerSees.json.applications.find(a => a.deletion_requested);
    ok(Boolean(marked), 'והגן רואה את בקשת המחיקה');
  } finally {
    await stop();
  }

  console.log(failures ? `\n❌  ${failures} מתוך ${checks} בדיקות נכשלו\n` : `\n🎉 כל ${checks} הבדיקות עברו\n`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
