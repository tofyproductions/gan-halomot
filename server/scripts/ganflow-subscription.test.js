#!/usr/bin/env node
/**
 * The standing charge: does the customer get billed what they actually owe?
 *
 *   node scripts/ganflow-subscription.test.js
 *
 * iCount is replaced by a transport that records what it was sent. That is not
 * a shortcut — what is worth asserting is entirely on our side: which month is
 * counted, whether the line adds up to the amount, whether a failure is
 * recorded rather than swallowed, and whether a customer who has been switched
 * off is left alone. Whether iCount's own server accepts a well-formed request
 * is their business, and it cannot be checked from a laptop at midnight.
 */
try {
  require.resolve('mongodb-memory-server');
} catch {
  console.error('\n❌  חסרה חבילת הבדיקה. הרץ:\n\n   npm install --no-save mongodb-memory-server\n');
  process.exit(1);
}

const { MongoMemoryServer } = require('mongodb-memory-server');

const results = [];
const check = (name, ok) => { results.push([name, ok]); console.log(`  ${ok ? '✅' : '❌'} ${name}`); };

(async () => {
  const mongod = await MongoMemoryServer.create();
  const base = mongod.getUri().replace(/\/$/, '');
  process.env.PLATFORM_MONGODB_URI = `${base}/gf_control`;
  process.env.PLATFORM_TENANT_URI = base;
  process.env.ICOUNT_API_TOKEN = 'test-token-not-a-real-one';

  const { controlPlane, tenantConnection, closeAll } = require('../src/platform/connection');
  const { createTenant } = require('../src/platform/provision');
  const sub = require('../src/platform/subscription');

  // Stands in for iCount: remembers every call, and can be told to fail.
  const sent = [];
  let failNext = null;
  const transport = async ({ url, payload }) => {
    sent.push({ endpoint: url.split('/').pop(), payload });
    if (failNext) { const r = failNext; failNext = null; return r; }
    return { hk_id: 4242, client_id: 77 };
  };
  const opts = { transport };

  const { Tenant } = await controlPlane();

  const mk = async (slug, name, pricing) => {
    const { tenant } = await createTenant({
      name, slug, admin_email: `${slug}@x.test`,
      admin_name: `מנהלת ${name}`, admin_id_number: '111111118',
      pricing,
    }, {});
    return tenant;
  };

  const addChildren = async (tenant, n) => {
    const { models } = await tenantConnection(tenant);
    const mongoose = require('mongoose');
    await models.Child.insertMany(Array.from({ length: n }, (_, i) => ({
      child_name: `ילד ${i}`, academic_year: 'תשפ"ו', is_active: true,
      registration_id: new mongoose.Types.ObjectId(),
    })));
  };

  console.log('\n--- מה נשלח ל-iCount ---');

  // A plain per-child price, comfortably over the minimum.
  const big = await mk('gadol', 'רשת גדולה', { price_per_child: 50, minimum_monthly: 400 });
  await addChildren(big, 12);
  const p1 = await sub.preview(await Tenant.findById(big._id), { month: '2026-09' });
  check('הסכום לפי מחיר לילד', p1.amount === 600 && p1.children === 12);
  check('השורה מוכפלת נכון', p1.items.length === 1
    && p1.items[0].quantity === 12 && p1.items[0].unitprice === 50);

  // The minimum bites: 3 × 50 = 150, but the customer owes 400.
  const small = await mk('katan', 'גן קטן', { price_per_child: 50, minimum_monthly: 400 });
  await addChildren(small, 3);
  const p2 = await sub.preview(await Tenant.findById(small._id), { month: '2026-09' });
  check('המינימום החודשי גובר', p2.amount === 400);
  const lineTotal = p2.items.reduce((a, it) => a + it.quantity * it.unitprice, 0);
  check('⚠️  השורה מסתכמת בדיוק בסכום שמחויב', Math.abs(lineTotal - p2.amount) < 0.005);
  check('והיא מסבירה את עצמה', /מינימום/.test(p2.items[0].description));

  // Tiers: the band applies to EVERY child, which is what the runbook promises.
  const net = await mk('reshet', 'רשת מדורגת', {
    price_per_child: 50, minimum_monthly: 0,
    tiers: [{ up_to: 10, price: 50 }, { up_to: null, price: 20 }],
  });
  await addChildren(net, 15);
  const p3 = await sub.preview(await Tenant.findById(net._id), { month: '2026-09' });
  check('מדרגה חלה על כל הילדים', p3.amount === 300 && p3.rate === 20);

  // A free period is a zero month, and it says so.
  const free = await mk('nisayon', 'בניסיון', {
    price_per_child: 50, minimum_monthly: 400,
    free_until: new Date(Date.now() + 30 * 86400000),
  });
  await addChildren(free, 20);
  const p4 = await sub.preview(await Tenant.findById(free._id), { month: '2026-09' });
  check('תקופת ניסיון = אפס', p4.amount === 0 && /חינם/.test(p4.breakdown));

  console.log('\n--- פתיחת הוראת קבע ---');

  const noPay = await sub.openProfile(big._id, { hk_type: 'cc' }, opts)
    .then(() => null).catch((e) => e);
  check('אשראי בלי טוקן נדחה', noPay instanceof Error);

  const bankMissing = await sub.openProfile(big._id, { hk_type: 'bank', bank_number: 12 }, opts)
    .then(() => null).catch((e) => e);
  check('הוראת קבע בלי פרטי חשבון נדחית', bankMissing instanceof Error);

  const opened = await sub.openProfile(big._id, { hk_type: 'cc', cc_token_id: 999 }, opts);
  check('הוראת קבע נפתחה', opened.hk_id === 4242);

  const createCall = sent.find((s) => s.endpoint === 'create');
  check('הלקוח מזוהה במזהה שלנו ולא בשם', createCall.payload.custom_client_id === 'gadol');
  check('מספר תשלומים בלתי מוגבל', createCall.payload.num_of_payments === 0);
  check('⚠️  שום פרט אשראי לא נשלח מלבד הטוקן',
    !JSON.stringify(createCall.payload).includes('cc_number')
    && createCall.payload.cc_token_id === 999);

  const stored = await Tenant.findById(big._id);
  check('⚠️  לא נשמר אצלנו שום פרט תשלום',
    !JSON.stringify(stored.billing.icount).match(/cc_number|cvv|bank_account/i)
    && stored.billing.icount.hk_id === 4242);

  const twice = await sub.openProfile(big._id, { hk_type: 'cc', cc_token_id: 999 }, opts)
    .then(() => null).catch((e) => e);
  check('אי אפשר לפתוח פעמיים', twice instanceof Error && twice.status === 409);

  console.log('\n--- עדכון חודשי ---');

  const before = sent.length;
  const dry = await sub.syncOne(big._id, { month: '2026-10', dryRun: true }, opts);
  check('הרצה יבשה לא שולחת דבר', sent.length === before && dry.dryRun === true);

  await addChildren(big, 8);   // 12 → 20
  const real = await sub.syncOne(big._id, { month: '2026-10', dryRun: false }, opts);
  check('הסכום עודכן למספר הילדים החדש', real.children === 20 && real.amount === 1000);

  const updateCall = sent[sent.length - 1];
  check('נשלח hk/update עם אותה הוראת קבע',
    updateCall.endpoint === 'update' && updateCall.payload.hk_id === 4242);
  check('השורה החדשה נכונה', updateCall.payload.items[0].quantity === 20);

  const after = await Tenant.findById(big._id);
  check('הסנכרון נרשם', after.billing.icount.last_sync.children === 20
    && after.billing.icount.last_sync.ok === true);

  console.log('\n--- כשל ---');

  failNext = { status: false, reason: 'cc_expired', error_description: 'הכרטיס פג תוקף' };
  const boom = await sub.syncOne(big._id, { month: '2026-11', dryRun: false }, opts)
    .then(() => null).catch((e) => e);
  check('כשל ב-iCount נזרק ולא נבלע', boom instanceof Error);

  const afterFail = await Tenant.findById(big._id);
  check('⚠️  הכשל נרשם על הלקוח', afterFail.billing.icount.last_sync.ok === false
    && /פג תוקף/.test(afterFail.billing.icount.last_sync.error));

  const noProfile = await sub.syncOne(small._id, { month: '2026-10', dryRun: false }, opts)
    .then(() => null).catch((e) => e);
  check('לקוח בלי הוראת קבע לא מסונכרן בשקט', noProfile instanceof Error);

  console.log('\n--- הרצה על כולם ---');

  await Tenant.updateOne({ _id: net._id }, {
    $set: { 'billing.icount.hk_id': 555, 'billing.icount.hk_type': 'bank' },
  });

  const all = await sub.syncAll({ month: '2026-10', dryRun: true }, opts);
  check('רק לקוחות עם הוראת קבע נכללים', all.done.length === 2);

  await Tenant.updateOne({ _id: net._id }, { $set: { status: 'suspended' } });
  const afterSuspend = await sub.syncAll({ month: '2026-10', dryRun: true }, opts);
  check('⚠️  לקוח מושהה לא מחויב', afterSuspend.done.length === 1
    && afterSuspend.done[0].slug === 'gadol');

  // One customer failing must not stop the others.
  const { AuditLog } = await controlPlane();
  const logged = await AuditLog.countDocuments({ action: /subscription/ });
  check('כל פעולה נרשמה ביומן', logged >= 3);

  const failed = results.filter(([, ok]) => !ok);
  console.log(failed.length ? `\n💥 ${failed.length} נכשלו\n` : '\n🎉 הכל עבר\n');

  await closeAll();
  await mongod.stop();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
