#!/usr/bin/env node
/**
 * What a customer owed, and whether it stays owed.
 *
 * The charge itself already has a test — this one is about the thing that makes
 * it an invoice rather than a screen: once a month has been worked out, adding
 * children must not change it. A live figure means March's bill moves in May,
 * and then the customer is right and we have no record to argue from.
 *
 *   node scripts/ganflow-billing.test.js
 */
try { require.resolve('mongodb-memory-server'); } catch {
  console.error('\n❌  חסרה חבילת הבדיקה. הרץ:\n\n   npm install --no-save mongodb-memory-server\n');
  process.exit(1);
}

const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient, ObjectId } = require('mongodb');

let failures = 0;
const ok = (cond, label) => { console.log(`  ${cond ? '✅' : '❌'} ${label}`); if (!cond) failures++; };

(async () => {
  const mongo = await MongoMemoryServer.create();
  const base = mongo.getUri();
  process.env.PLATFORM_MONGODB_URI = base + 'gf_control';
  process.env.MONGODB_URI = base + 'gf_unused';

  const client = await MongoClient.connect(base);
  const plat = client.db('gf_control');

  const mk = async (slug, name, pricing, kids) => {
    const _id = new ObjectId();
    await plat.collection('tenants').insertOne({
      _id, name, slug, status: 'active', db_uri: base, db_name: `gf_${slug}`,
      pricing, entitlements: {}, created_at: new Date(),
    });
    const db = client.db(`gf_${slug}`);
    if (kids) {
      await db.collection('children').insertMany(
        Array.from({ length: kids }, (_, i) => ({ child_name: `ילד ${i}`, is_active: true })),
      );
    }
    return _id;
  };

  // Three shapes that must each be explainable to the customer who asks.
  await mk('flat', 'גן שטוח', { price_per_child: 50, minimum_monthly: 400 }, 30);   // 30×50 = 1500
  await mk('tiny', 'גן קטן', { price_per_child: 50, minimum_monthly: 400 }, 3);     // 150 → minimum 400
  await mk('net', 'רשת', {
    price_per_child: 50, minimum_monthly: 400,
    tiers: [{ up_to: 500, price: 20 }, { up_to: null, price: 12 }],
  }, 600);                                                                          // 600×12 = 7200
  await mk('free', 'בחינם', {
    price_per_child: 50, minimum_monthly: 400,
    free_until: new Date(Date.now() + 30 * 864e5),
  }, 40);                                                                            // 0
  const suspended = await mk('gone', 'מושהה', { price_per_child: 50, minimum_monthly: 400 }, 99);
  await plat.collection('tenants').updateOne({ _id: suspended }, { $set: { status: 'suspended' } });

  const { runMonth } = require('../src/platform/billing');
  const { controlPlane, closeAll } = require('../src/platform/connection');

  console.log('\n--- הרצת חודש ---');
  const run = await runMonth({ month: '2026-07' });
  const by = Object.fromEntries(run.rows.map((r) => [r.tenant_slug, r]));

  ok(run.failed.length === 0, `אף לקוח לא נכשל (${run.failed.length})`);
  ok(by.flat?.amount === 1500, `מחיר אחיד: 30 ילדים × ₪50 = ₪${by.flat?.amount} (צפוי 1500)`);
  ok(by.tiny?.amount === 400, `מתחת למינימום: 3 ילדים → ₪${by.tiny?.amount} (צפוי 400)`);
  ok(by.net?.amount === 7200, `מדרגה עליונה: 600 ילדים × ₪12 = ₪${by.net?.amount} (צפוי 7200)`);
  ok(by.free?.amount === 0, `חודש חינם: ₪${by.free?.amount} (צפוי 0)`);
  ok(!by.gone, 'לקוח מושהה לא חויב כלל');

  console.log('\n--- ההסבר נשמר במילים ---');
  ok(/מינימום/.test(by.tiny?.breakdown || ''), `הקטן יודע להסביר: "${by.tiny?.breakdown}"`);
  ok(/מדרגה/.test(by.net?.breakdown || ''), `הרשת יודעת להסביר: "${by.net?.breakdown}"`);
  ok(/חינם/.test(by.free?.breakdown || ''), `החינם יודע להסביר: "${by.free?.breakdown}"`);

  console.log('\n--- והמספר קפוא ---');
  // The whole point. Two more children join after the run.
  await client.db('gf_flat').collection('children').insertMany([
    { child_name: 'ילד חדש א', is_active: true },
    { child_name: 'ילד חדש ב', is_active: true },
  ]);
  const again = await runMonth({ month: '2026-07' });
  const flatAgain = again.rows.find((r) => r.tenant_slug === 'flat');
  ok(flatAgain?.amount === 1500, `אחרי שנרשמו עוד 2 ילדים, יולי נשאר ₪${flatAgain?.amount} (צפוי 1500)`);
  ok(flatAgain?.skipped === true, 'החודש לא חושב מחדש מעצמו');

  const { BillingPeriod } = await controlPlane();
  const stored = await BillingPeriod.findOne({ month: '2026-07', tenant_slug: 'flat' }).lean();
  ok(stored.children === 30, `ובמסד נשמרה הספירה של אז: ${stored.children} (צפוי 30)`);

  const recomputed = await runMonth({ month: '2026-07', recompute: true });
  const flatRe = recomputed.rows.find((r) => r.tenant_slug === 'flat');
  ok(flatRe?.amount === 1600, `חישוב מחדש מכוון כן מעדכן: ₪${flatRe?.amount} (צפוי 1600)`);

  console.log('\n--- חודש שכבר נמסר ללקוח לא משתנה בפקודה ---');
  await BillingPeriod.updateOne({ month: '2026-07', tenant_slug: 'net' }, { $set: { status: 'issued' } });
  await client.db('gf_net').collection('children').insertOne({ child_name: 'עוד אחד', is_active: true });
  const third = await runMonth({ month: '2026-07', recompute: true });
  const netRow = third.rows.find((r) => r.tenant_slug === 'net');
  ok(netRow?.locked === true, 'חודש שנמסר מסומן כנעול');
  ok(netRow?.amount === 7200, `וסכומו לא זז: ₪${netRow?.amount} (צפוי 7200)`);

  console.log(failures ? `\n❌  ${failures} בדיקות נכשלו\n` : '\n🎉 הכל עבר\n');
  await closeAll();
  await client.close();
  await mongo.stop();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
