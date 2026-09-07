#!/usr/bin/env node
/**
 * The database-level fail-safe: a viewer's write that no gate claimed never
 * reaches the driver.
 *
 * WHAT IS BEING PROVEN. src/utils/viewerWriteGuard.js is a mongoose plugin.
 * On every write operation mongoose 8 lets middleware run on it asks
 * src/utils/viewerContext.js three questions in order:
 *
 *   is there a viewer-write context?   no  → pass (every other role, every
 *                                             read, the approver's replay)
 *   did a gate claim it?               yes → pass (requireRole / requireTab /
 *                                             requireTabWrite / requireBranchScope
 *                                             let her through on purpose)
 *   otherwise                              → file ONE proposal for the request
 *                                             and reject the operation.
 *
 * The database here is a real mongod in a temp directory (mongodb-memory-server),
 * because "the write proceeds" is only worth asserting against a database that
 * would really have taken it. server/.env is never read — dotenv is stubbed out
 * of require.cache before anything can load it — and the connection host is
 * checked to be loopback before a single document is written.
 *
 *   node scripts/viewer-write-guard.test.js
 */

/* ------------------------------------------------------------------ *
 * 1. The proposal service opens the models; record the call, answer 202.
 * ------------------------------------------------------------------ */
const Module = require('module');
const proposals = [];
const realLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (request.endsWith('services/proposedChanges.service')) {
    return {
      propose: async (req, res) => {
        proposals.push({ method: req.method, url: req.originalUrl, role: req.user?.role });
        if (!res.headersSent) res.status(202).json({ proposed: true, id: `pc-${proposals.length}` });
        return { _id: `pc-${proposals.length}` };
      },
    };
  }
  return realLoad.call(this, request, parent, ...rest);
};

/* 2. Nothing may read server/.env. */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const viewerContext = require('../src/utils/viewerContext');
const guardPlugin = require('../src/utils/viewerWriteGuard');

let failures = 0;
const ok = (cond, label, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${label}${cond ? '' : `  (${extra})`}`);
  if (!cond) failures++;
  return !!cond;
};
const eq = (a, b, label) => ok(
  JSON.stringify(a) === JSON.stringify(b), label,
  `קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)}`,
);

function fakeReq(method, url, contentType = 'application/json') {
  return {
    method,
    originalUrl: url,
    headers: { 'content-type': contentType },
    user: { id: 'u-viewer', full_name: 'אלעד צופה', role: 'branch_manager', actual_role: 'admin_viewer' },
    body: {}, params: {}, query: {},
  };
}
function fakeRes() {
  const r = { statusCode: 200, body: null, headersSent: false };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; r.headersSent = true; return r; };
  return r;
}

/** Run `fn` inside a fresh viewer-write context; `claimBy` claims it first. */
function inContext(fn, {
  claimBy = null, method = 'POST', url = '/api/probe', contentType = 'application/json',
} = {}) {
  const req = fakeReq(method, url, contentType);
  const res = fakeRes();
  return viewerContext.runViewerWrite(req, res, async () => {
    if (claimBy) viewerContext.claim(claimBy);
    const out = await fn();
    return { out, req, res, state: viewerContext.get() };
  });
}

/** Resolve to the rejection, or to null when the operation succeeded. */
async function rejection(promise) {
  try { await promise; return null; } catch (err) { return err; }
}

let mongod = null;
let Probe = null;

async function main() {
  console.log('\n🛡  שומר הכתיבה של הצופה (מפלס מסד הנתונים)\n');

  mongod = await MongoMemoryServer.create({ instance: { dbName: 'gan_viewer_guard' } });
  await mongoose.connect(mongod.getUri());
  const host = String(mongoose.connection.host || '');
  if (!/^(127\.0\.0\.1|localhost|::1)$/.test(host)) {
    throw new Error(`מסד הנתונים אינו מקומי (${host}) — עוצרים`);
  }

  // A throwaway model, plugged by hand — the same plugin src/models/index.js
  // registers globally, without dragging the application's 90 schemas in.
  const schema = new mongoose.Schema({ name: String, n: { type: Number, default: 0 } });
  schema.plugin(guardPlugin);
  Probe = mongoose.model('GuardProbe', schema);
  const count = () => Probe.countDocuments({});

  /* ---------------------------------------------------------------- */
  console.log('מחוץ לכל הקשר — כלום לא משתנה');
  {
    proposals.length = 0;
    const doc = await Probe.create({ name: 'ordinary' });
    ok(!!doc?._id, 'Model.create מחוץ להקשר נשמר');
    await Probe.updateOne({ _id: doc._id }, { $set: { n: 1 } });
    eq((await Probe.findById(doc._id).lean()).n, 1, 'updateOne מחוץ להקשר עודכן');
    await Probe.deleteOne({ _id: doc._id });
    eq(await count(), 0, 'deleteOne מחוץ להקשר מחק');
    eq(proposals.length, 0, 'ולא נשמרה שום הצעה');
  }

  /* ---------------------------------------------------------------- */
  console.log('\nהקשר שנתבע ע"י שער — הכתיבה עוברת');
  {
    proposals.length = 0;
    const { out } = await inContext(
      async () => Probe.create({ name: 'claimed' }),
      { claimBy: 'requireRole:system_admin|branch_manager' },
    );
    ok(!!out?._id, 'save בהקשר תבוע נשמר');
    eq(proposals.length, 0, 'ולא נשמרה הצעה');
    const r2 = await inContext(async () => {
      await Probe.updateOne({ name: 'claimed' }, { $set: { n: 7 } });
      return Probe.findOne({ name: 'claimed' }).lean();
    }, { claimBy: 'requireBranchScope:role' });
    eq(r2.out.n, 7, 'updateOne בהקשר תבוע עודכן');
    eq(proposals.length, 0, 'ועדיין ללא הצעה');
    await Probe.deleteMany({});
  }

  /* ---------------------------------------------------------------- */
  console.log('\nהקשר ללא תביעה — הכתיבה נדחית וההצעה נשמרת');
  {
    proposals.length = 0;
    const { out, res, state } = await inContext(async () => {
      const first = await rejection(Probe.create({ name: 'unclaimed' }));
      // A SECOND write in the same request must not file a second proposal.
      const second = await rejection(Probe.updateOne({ name: 'x' }, { $set: { n: 2 } }));
      return { first, second };
    });
    eq(out.first?.code, 'VIEWER_UNCLAIMED_WRITE', 'הכתיבה הראשונה נדחתה עם VIEWER_UNCLAIMED_WRITE');
    eq(out.first?.name, 'ViewerUnclaimedWriteError', 'ובשם ViewerUnclaimedWriteError');
    ok(out.first instanceof guardPlugin.ViewerUnclaimedWriteError,
      'ומטיפוס השגיאה שהמודול מייצא');
    eq(out.second?.code, 'VIEWER_UNCLAIMED_WRITE', 'גם הכתיבה השנייה נדחתה');
    eq(proposals.length, 1, 'ונשמרה הצעה אחת בלבד לשתיהן');
    eq(res.statusCode, 202, 'התשובה היא 202');
    eq(res.body?.proposed, true, 'עם proposed: true');
    eq(state.proposed, true, 'ההקשר מסומן proposed');
    eq(state.claimed, false, 'ולא נתבע');
    eq(await count(), 0, 'ולא נכתב דבר במסד');
  }

  /* ---------------------------------------------------------------- */
  console.log('\nכל פעולות הכתיבה — כל אחת נדחית ומגישה הצעה');
  {
    await Probe.create({ name: 'target', n: 0 });   // outside any context
    const ops = {
      'save (Model.create)': () => Probe.create({ name: 'new' }),
      'save (doc.save)': async () => {
        const d = await Probe.findOne({ name: 'target' });
        d.n = 99;
        return d.save();
      },
      updateOne: () => Probe.updateOne({ name: 'target' }, { $set: { n: 5 } }),
      updateMany: () => Probe.updateMany({}, { $set: { n: 6 } }),
      findOneAndUpdate: () => Probe.findOneAndUpdate({ name: 'target' }, { $set: { n: 7 } }),
      findByIdAndUpdate: async () => {
        const d = await Probe.findOne({ name: 'target' }).lean();
        return Probe.findByIdAndUpdate(d._id, { $set: { n: 8 } });
      },
      deleteOne: () => Probe.deleteOne({ name: 'target' }),
      deleteMany: () => Probe.deleteMany({ name: 'target' }),
      findOneAndDelete: () => Probe.findOneAndDelete({ name: 'target' }),
      replaceOne: () => Probe.replaceOne({ name: 'target' }, { name: 'target', n: 3 }),
      insertMany: () => Probe.insertMany([{ name: 'bulk-a' }, { name: 'bulk-b' }]),
      bulkWrite: () => Probe.bulkWrite([{ insertOne: { document: { name: 'bulk-c' } } }]),
    };
    for (const [label, run] of Object.entries(ops)) {
      proposals.length = 0;
      const before = await count();
      const { out, res } = await inContext(() => rejection(run()));
      ok(out?.code === 'VIEWER_UNCLAIMED_WRITE', `${label} — נדחה`, `קיבלנו ${out?.code || 'הצלחה'}`);
      ok(proposals.length === 1 && res.statusCode === 202, `${label} — הצעה אחת ו-202`,
        `proposals=${proposals.length} status=${res.statusCode}`);
      ok(await count() === before, `${label} — המסד לא השתנה`);
    }
  }

  /* ---------------------------------------------------------------- */
  console.log('\nהעלאת קובץ במסלול ללא שער — סירוב, לא הצעה מתה');
  {
    // A multipart body cannot be stored and replayed as JSON: multer has
    // already consumed it, so a proposal filed here would carry
    // content_type: multipart/... with a JSON body, and the replay would hand
    // busboy an object and fail. So the guard refuses (403 VIEWER_NO_UPLOAD),
    // does NOT file, and still rejects the write.
    proposals.length = 0;
    const before = await count();
    const { out, res, state } = await inContext(
      () => rejection(Probe.create({ name: 'uploaded' })),
      { url: '/api/documents/upload', contentType: 'multipart/form-data; boundary=--x' },
    );
    eq(out?.code, 'VIEWER_UNCLAIMED_WRITE', 'הכתיבה נדחתה גם בהעלאה');
    eq(res.statusCode, 403, 'התשובה היא 403 ולא 202');
    eq(res.body?.code, 'VIEWER_NO_UPLOAD', 'עם הקוד VIEWER_NO_UPLOAD');
    ok(typeof res.body?.error === 'string' && res.body.error.length > 0, 'ועם הסבר בעברית');
    eq(proposals.length, 0, 'ולא נשמרה שום הצעה');
    eq(state.proposed, true, 'ההקשר בכל זאת מסומן proposed — כדי להשתיק את מה שיבוא');
    eq(await count(), before, 'והמסד לא השתנה');

    // A second write in the same request answers nothing more and files nothing.
    proposals.length = 0;
    const r2 = await inContext(async () => {
      const first = await rejection(Probe.create({ name: 'uploaded-1' }));
      const second = await rejection(Probe.updateOne({ name: 'target' }, { $set: { n: 1 } }));
      return { first, second };
    }, { url: '/api/documents/upload', contentType: 'multipart/form-data; boundary=--x' });
    eq(r2.out.second?.code, 'VIEWER_UNCLAIMED_WRITE', 'כתיבה שנייה בהעלאה — עדיין נדחית');
    eq(proposals.length, 0, 'ועדיין ללא הצעה');
    eq(r2.res.body?.code, 'VIEWER_NO_UPLOAD', 'והתשובה נשארה הסירוב הראשון');

    // The refusal is the very same object middleware/auth.js answers with, so
    // the three places that refuse an upload can never drift apart.
    const { NO_UPLOAD } = require('../src/utils/viewer');
    eq(res.body, NO_UPLOAD, 'וזהו בדיוק NO_UPLOAD מ-utils/viewer.js');
  }

  /* ---------------------------------------------------------------- */
  console.log('\nקריאות אינן נוגעות בשומר');
  {
    proposals.length = 0;
    const { out } = await inContext(async () => ({
      find: (await Probe.find({}).lean()).length,
      one: await Probe.findOne({ name: 'target' }).lean(),
      n: await Probe.countDocuments({}),
      agg: await Probe.aggregate([{ $group: { _id: null, c: { $sum: 1 } } }]),
    }));
    ok(typeof out.find === 'number', 'find עובד בתוך הקשר ללא תביעה');
    ok(typeof out.n === 'number', 'countDocuments עובד');
    ok(Array.isArray(out.agg), 'aggregate עובד');
    eq(proposals.length, 0, 'ולא נשמרה שום הצעה');
  }

  /* ---------------------------------------------------------------- */
  console.log('\nהתביעה — מה שהשערים עושים');
  {
    // claim() outside a context is a no-op that says so, so a gate may call it
    // unconditionally without knowing whether a viewer is behind the request.
    eq(viewerContext.claim('nobody'), false, 'claim מחוץ להקשר מחזיר false');
    eq(viewerContext.get(), null, 'ו-get מחזיר null');

    const { state } = await inContext(async () => null, { claimBy: 'requireRole:a' });
    eq(state.claimed, true, 'בתוך הקשר — claimed');
    eq(state.claim_reason, 'requireRole:a', 'והסיבה נשמרת');

    // Idempotent: the first claim decides, later ones are only recorded.
    const req = fakeReq('POST', '/api/probe');
    const res = fakeRes();
    const s2 = await viewerContext.runViewerWrite(req, res, async () => {
      viewerContext.claim('first');
      viewerContext.claim('second');
      return viewerContext.get();
    });
    eq(s2.claim_reason, 'first', 'תביעה שנייה אינה משנה את הסיבה');
    eq(s2.claims, ['first', 'second'], 'אבל שתיהן נרשמות');
  }

  /* ---------------------------------------------------------------- */
  console.log('\nההקשר שורד await ו-setTimeout (מה שהופך את זה לאמין לאורך בקשה)');
  {
    proposals.length = 0;
    const { out } = await inContext(async () => {
      await new Promise(r => setTimeout(r, 10));
      await Probe.findOne({}).lean();
      return rejection(Probe.updateOne({ name: 'target' }, { $set: { n: 42 } }));
    });
    eq(out?.code, 'VIEWER_UNCLAIMED_WRITE', 'כתיבה אחרי setTimeout ו-await עדיין נדחית');
    eq(proposals.length, 1, 'ונשמרה הצעה');
  }

  /* ---------------------------------------------------------------- */
  console.log('\nהתוסף מותקן פעם אחת בלבד');
  {
    const s = new mongoose.Schema({ a: String });
    guardPlugin(s);
    guardPlugin(s);
    const pres = s.s.hooks._pres.get('save') || [];
    eq(pres.length, 1, 'רישום כפול של התוסף אינו מוסיף hook שני');
  }
}

async function teardown() {
  try { await mongoose.disconnect(); } catch { /* not connected */ }
  try { if (mongod) await mongod.stop(); } catch { /* already stopped */ }
}

const watchdog = setTimeout(async () => {
  console.error('\n❌ הבדיקה חרגה מ-90 שניות — עוצרים');
  await teardown();
  process.exit(1);
}, 90000);
watchdog.unref();

main()
  .then(async () => {
    await teardown();
    clearTimeout(watchdog);
    console.log(failures === 0 ? '\n✅ הכל עבר\n' : `\n❌ ${failures} בדיקות נכשלו\n`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (err) => {
    console.error('\n❌ הבדיקה קרסה:', err.message);
    console.error(err.stack);
    await teardown();
    clearTimeout(watchdog);
    process.exit(1);
  });
