/**
 * Proves the one property the whole design rests on: two customers cannot see
 * each other, and the org tree survives being rearranged.
 *
 *   node scripts/ganflow-platform.test.js
 */
/**
 * mongodb-memory-server is deliberately NOT a dependency of this package.
 * Render runs `npm install` on every deploy and would download a MongoDB
 * binary into the build of a gan that is serving families — a hundred
 * megabytes and a new way for the deploy to fail, in exchange for a package
 * only ever used on a laptop. Install it when you want to run the test:
 *
 *   npm install --no-save mongodb-memory-server
 */
try {
  require.resolve('mongodb-memory-server');
} catch {
  console.error('\n\u274C  חסרה חבילת הבדיקה. הרץ:\n\n   npm install --no-save mongodb-memory-server\n');
  process.exit(1);
}

const { MongoMemoryServer } = require('mongodb-memory-server');

(async () => {
  const mongod = await MongoMemoryServer.create();
  const base = mongod.getUri().replace(/\/$/, '');

  process.env.PLATFORM_MONGODB_URI = `${base}/gf_control`;
  // Where customers' databases are opened. Required now, and this test failing
  // without it is the point: it used to inherit whatever MONGODB_URI the
  // process happened to carry, which for a script run from server/ is the gan's
  // production cluster.
  process.env.PLATFORM_TENANT_URI = base;
  process.env.MONGODB_URI = `${base}/unused_default`;
  process.env.NODE_ENV = 'test';

  const { controlPlane, tenantConnection, closeAll, withDbName } = require('../src/platform/connection');
  const { createTenant, suspendTenant, tenantUsage } = require('../src/platform/provision');

  const results = [];
  const check = (label, ok) => { results.push([label, ok]); console.log(`  ${ok ? '✅' : '❌'} ${label}`); };

  // ---------------------------------------------------------------- create
  const a = await createTenant({
    name: 'גן שלהבת', slug: 'shalhevet', admin_email: 'a@shalhevet.test',
    admin_name: 'מנהלת שלהבת', admin_id_number: '111111118', first_branch_name: 'שלהבת',
  }, { email: 'owner@ganflow.test' });

  const b = await createTenant({
    name: 'רשת מעונות אורים', slug: 'urim', admin_email: 'b@urim.test',
    admin_name: 'מנהל רשת', admin_id_number: '222222226', is_network: true, first_branch_name: 'אורים מרכז',
    pricing: { price_per_child: 12, minimum_monthly: 5000, tiers: [{ up_to: 500, price: 50 }, { up_to: null, price: 12 }] },
  }, { email: 'owner@ganflow.test' });

  check('שני לקוחות נוצרו', a.tenant.slug === 'shalhevet' && b.tenant.slug === 'urim');
  check('כל לקוח קיבל מסד משלו', a.tenant.db_name === 'gf_shalhevet' && b.tenant.db_name === 'gf_urim');
  check('סיסמה זמנית הופקה', Boolean(a.tempPassword) && a.tempPassword !== b.tempPassword);

  // ------------------------------------------------------------- isolation
  const A = (await tenantConnection(a.tenant)).models;
  const B = (await tenantConnection(b.tenant)).models;

  const reg = await A.Registration.create({ child_name: 'ילדה של שלהבת', academic_year: 'תשפ"ו' }).catch(() => null);
  await A.Child.create({
    registration_id: reg?._id || new (require('mongoose').Types.ObjectId)(),
    child_name: 'ילדה של שלהבת', academic_year: 'תשפ"ו', is_active: true,
  });
  await B.Child.create({
    registration_id: new (require('mongoose').Types.ObjectId)(),
    child_name: 'ילד של אורים', academic_year: 'תשפ"ו', is_active: true,
  });

  const aChildren = await A.Child.find({});
  const bChildren = await B.Child.find({});
  check('לקוח א רואה רק את הילדים שלו', aChildren.length === 1 && aChildren[0].child_name === 'ילדה של שלהבת');
  check('לקוח ב רואה רק את הילדים שלו', bChildren.length === 1 && bChildren[0].child_name === 'ילד של אורים');

  // A query with no filter at all — the shape of every one of the 58
  // controllers today — still cannot cross.
  const leak = await A.Child.find({ child_name: 'ילד של אורים' });
  check('שאילתה ללא סינון לא חוצה לקוחות', leak.length === 0);

  const aUsers = await A.User.find({});
  check('משתמש ראשון נוצר עם system_admin', aUsers.length === 1 && aUsers[0].role === 'system_admin');
  // This used to assert password_set === false, in the belief that it forced a
  // password to be chosen at first login. It does the reverse: step one of
  // login issues a token outright when no password is set, so the temporary
  // password was never asked for and a name plus an id number opened the gan.
  check('הכניסה הראשונה דורשת את הסיסמה הזמנית', aUsers[0].password_set === true);
  check('למנהל/ת יש תעודת זהות להיכנס איתה', /^\d{5,9}$/.test(aUsers[0].id_number || ''));

  // -------------------------------------------------------------- org tree
  const network = await B.OrgUnit.findOne({ kind: 'network' });
  const district = await B.OrgUnit.create({ name: 'מחוז שרון', kind: 'district', parent_id: network._id, path: [network._id], depth: 1 });
  const cluster = await B.OrgUnit.create({ name: 'אשכול כפר סבא', kind: 'cluster', parent_id: district._id, path: [network._id, district._id], depth: 2 });
  const branchUnit = await B.OrgUnit.findOne({ kind: 'branch' });

  await B.OrgUnit.reparent(branchUnit._id, cluster._id);
  const moved = await B.OrgUnit.findById(branchUnit._id);
  check('עומק חופשי — רשת→מחוז→אשכול→סניף', moved.depth === 3 && String(moved.path[0]) === String(network._id));

  const under = await B.OrgUnit.branchesUnder([district._id]);
  check('שאלת "כל הסניפים תחת מחוז" עובדת', under.length === 1);

  const cycle = await B.OrgUnit.reparent(network._id, cluster._id).then(() => false).catch(() => true);
  check('אי אפשר להזיז יחידה מתחת לעצמה', cycle);

  // A district moved with a branch under it keeps the branch.
  const district2 = await B.OrgUnit.create({ name: 'מחוז דרום', kind: 'district', parent_id: network._id, path: [network._id], depth: 1 });
  await B.OrgUnit.reparent(district._id, district2._id);
  const afterMove = await B.OrgUnit.findById(branchUnit._id);
  check('הזזת מחוז גוררת את הסניפים שתחתיו', afterMove.depth === 4 && afterMove.path.length === 4);

  // --------------------------------------------------------------- pricing
  const usageA = await tenantUsage(a.tenant);
  check('חיוב מינימום כשיש ילד אחד', usageA.monthly_charge === 400);

  check('מדרגה עליונה לרשת (300 ילדים → 15,000)', b.tenant.monthlyCharge(300) === 15000);
  check('מדרגה תחתונה לרשת (17,500 ילדים → 210,000)', b.tenant.monthlyCharge(17500) === 210000);
  check('מינימום גובר על מדרגה', b.tenant.monthlyCharge(1) === 5000);

  const freeT = { pricing: { price_per_child: 50, minimum_monthly: 400, free_until: new Date(Date.now() + 86400000), tiers: [] },
                  monthlyCharge: b.tenant.monthlyCharge };
  check('חודש חינם = 0', freeT.monthlyCharge.call(freeT, 42) === 0);

  // ------------------------------------------------------------- suspend
  await suspendTenant(b.tenant._id, 'לא שולם', { email: 'owner@ganflow.test' });
  const { Tenant, AuditLog } = await controlPlane();
  const susp = await Tenant.findById(b.tenant._id);
  const months = (susp.purge_after - susp.suspended_at) / 86400000;
  check('השהיה שומרת מידע לחצי שנה', susp.status === 'suspended' && months > 175 && months < 190);

  const stillThere = await (await tenantConnection(susp)).models.Child.countDocuments();
  check('מידע של לקוח מושהה לא נמחק', stillThere === 1);

  const log = await AuditLog.find({});
  check('כל פעולה נרשמה ביומן', log.length >= 3 && log.some((l) => l.action === 'tenant.suspend'));

  // ------------------------------------------------------------- slug rules
  const badSlugs = ['ab', 'admin', 'console', 'has_underscore', 'ends-', '-starts', 'a'.repeat(40)];
  let refusedAll = true;
  for (const slug of badSlugs) {
    const ok = await createTenant({ name: 'x', slug, admin_email: 'x@x.test' }, {}).then(() => false).catch(() => true);
    if (!ok) refusedAll = false;
  }
  check('כתובות פסולות ושמורות נדחות', refusedAll);

  const dup = await createTenant({ name: 'x', slug: 'shalhevet', admin_email: 'x@x.test' }, {}).then(() => false).catch(() => true);
  check('כתובת תפוסה נדחית', dup);

  // Typed with capitals, stored lowercase — the address is read down a
  // telephone and typed into a browser, both of which are case-blind.
  const cased = await createTenant({ name: 'גן ההר', slug: 'Har-Habait', admin_email: 'c@har.test', admin_name: 'מנהלת ההר', admin_id_number: '333333334' }, {});
  check('אותיות גדולות מתוקנות ולא נדחות', cased.tenant.slug === 'har-habait');

  const tenantsNow = await Tenant.countDocuments();
  check('יצירה שנכשלה לא משאירה לקוח חצי', tenantsNow === 3);

  // ---------------------------------------------- the first console account
  // Seeded at boot from the environment, because the platform is switched on
  // from a dashboard by somebody with no terminal. The rules that keep that
  // safe are the ones worth asserting.
  const { seedOwnerFromEnv } = require('../src/platform/bootstrap');
  const { PlatformUser } = await controlPlane();
  await PlatformUser.deleteMany({});

  delete process.env.PLATFORM_OWNER_EMAIL;
  delete process.env.PLATFORM_OWNER_PASSWORD;
  check('בלי משתנים לא נוצר כלום', (await seedOwnerFromEnv()).seeded === false
    && await PlatformUser.countDocuments() === 0);

  process.env.PLATFORM_OWNER_EMAIL = 'owner@halom.test';
  process.env.PLATFORM_OWNER_PASSWORD = 'short';
  check('סיסמה קצרה נדחית', (await seedOwnerFromEnv()).seeded === false
    && await PlatformUser.countDocuments() === 0);

  // A value pasted into a dashboard field brings whatever came with it.
  process.env.PLATFORM_OWNER_PASSWORD = '  a-long-enough-one  ';
  check('נוצר בעלים', (await seedOwnerFromEnv()).seeded === true);
  const owner = await PlatformUser.findOne({ email: 'owner@halom.test' });
  check('התפקיד הוא בעלים', owner && owner.role === 'owner');
  check('רווחים מסביב לסיסמה לא נשמרים',
    await require('bcryptjs').compare('a-long-enough-one', owner.password_hash));

  // The one that matters: an environment variable must not be a way in to a
  // console that already has an owner.
  process.env.PLATFORM_OWNER_EMAIL = 'intruder@halom.test';
  process.env.PLATFORM_OWNER_PASSWORD = 'another-long-one';
  check('⚠️  משתנה סביבה לא מוסיף בעלים לקונסולה קיימת',
    (await seedOwnerFromEnv()).seeded === false
    && await PlatformUser.countDocuments() === 1);

  await PlatformUser.deleteMany({});
  delete process.env.PLATFORM_OWNER_EMAIL;
  delete process.env.PLATFORM_OWNER_PASSWORD;

  // ------------------------------------------------- adopting a full database
  // A database that already has people in it — the demo, a customer moved off
  // a full cluster, a customer restored from an export. The customer must
  // point AT it, and provisioning must not overwrite or drop what it finds.
  const donor = await createTenant({
    name: 'גן התורם', slug: 'donor', admin_email: 'd@donor.test',
    admin_name: 'מנהלת התורם', admin_id_number: '444444445',
  }, {});
  const donorModels = (await tenantConnection(donor.tenant)).models;
  await donorModels.Child.create({ child_name: 'תמר לוי', academic_year: 'תשפ"ו', is_active: true,
    registration_id: new (require('mongoose').Types.ObjectId)() });
  const donorDbName = donor.tenant.db_name;
  const donorUri = donor.tenant.db_uri || process.env.PLATFORM_TENANT_URI;
  await Tenant.deleteOne({ _id: donor.tenant._id });     // the row goes; the database stays

  const adopted = await createTenant({
    name: 'גן המאומץ', slug: 'adopted', db_uri: donorUri, adopt_db_name: donorDbName,
    admin_email: 'a@adopted.test', admin_name: 'מנהלת המאומץ', admin_id_number: '555555556',
  }, {});
  check('לקוח מאומץ מצביע על המסד הקיים', adopted.tenant.db_name === donorDbName);

  const am = (await tenantConnection(adopted.tenant)).models;
  check('הילדים שהיו במסד עדיין שם', await am.Child.countDocuments() === 1);
  check('לא נוצר סניף שני', await am.Branch.countDocuments() === 1);
  check('שורש העץ לא הוכפל', await am.OrgUnit.countDocuments({ parent_id: null }) === 1);

  // The one that matters: a provisioning that fails midway must delete its own
  // row and LEAVE THE DATABASE ALONE. `rollback()` drops databases.
  await Tenant.deleteOne({ _id: adopted.tenant._id });
  const boom = await createTenant({
    name: 'ניסיון שנכשל', slug: 'doomed', db_uri: donorUri, adopt_db_name: donorDbName,
    // Same email as the administrator already in there, different id number:
    // the user is not recognised as present, and creating it collides.
    admin_email: 'd@donor.test', admin_name: 'מישהו אחר', admin_id_number: '666666667',
  }, {}).then(() => null).catch((e) => e);
  check('אימוץ שנכשל נעצר', boom instanceof Error);
  check('אימוץ שנכשל לא השאיר לקוח חצי', await Tenant.countDocuments({ slug: 'doomed' }) === 0);

  const survivors = await (await tenantConnection({ slug: 'check-donor', db_name: donorDbName, db_uri: donorUri }))
    .models.Child.countDocuments();
  check('⚠️  אימוץ שנכשל לא מחק את המסד', survivors === 1);

  // ------------------------------------------------------- the address itself
  // Which customer a request belongs to is decided by the host name and
  // nothing else, so the rule that reads it is worth an assertion. The one
  // that matters is the Render host: it serves the console and the demo, and
  // reading it as a customer breaks the platform's own address.
  const { slugFromHost } = require('../src/platform/resolve');
  process.env.PLATFORM_DOMAIN = 'dreamgan.com';
  check('כתובת לקוח מזוהה', slugFromHost('shalhevet.dreamgan.com') === 'shalhevet');
  check('אותיות גדולות ונקודה מסיימת לא מבלבלות', slugFromHost('Shalhevet.DreamGan.com.') === 'shalhevet');
  check('פורט לא מבלבל', slugFromHost('shalhevet.dreamgan.com:8080') === 'shalhevet');
  check('הכתובת של רנדר איננה לקוח', slugFromHost('dreamgan.onrender.com') === null);
  check('הדומיין עצמו איננו לקוח', slugFromHost('dreamgan.com') === null && slugFromHost('www.dreamgan.com') === null);
  check('שם שמור איננו לקוח', slugFromHost('console.dreamgan.com') === null);
  check('דומיין זר איננו לקוח', slugFromHost('shalhevet.example.com') === null);
  check('לוקאלהוסט ו-IP אינם לקוח', slugFromHost('localhost:5000') === null && slugFromHost('127.0.0.1') === null);

  const failed = results.filter(([, ok]) => !ok);
  console.log(failed.length ? `\n💥 ${failed.length} נכשלו\n` : '\n🎉 הכל עבר\n');

  await closeAll();
  await mongod.stop();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
