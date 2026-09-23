/**
 * מה שהורה רשאי לשנות לגבי מי בתמונה — ולמה זה שני כפתורים ולא אחד.
 *
 * The split between a correction and a preference is the rule under test, and
 * it is not cosmetic. "זה לא הילד שלי" says the tag is WRONG: it comes off for
 * everyone and the system learns. "אל תציג לי את זה" says the tag is RIGHT and
 * they simply do not want the photograph. Collapse the two and a parent hiding
 * a frame where their child is crying teaches the recogniser that their child
 * is not their child — and after a dozen of those the family's gallery quietly
 * stops working.
 *
 * The other rule: a parent's "that IS my child" counts for their own gallery
 * at once — they can already see the photograph in the classroom gallery — but
 * must not teach until staff agree. A parent tapping the wrong face would
 * otherwise train the system on another family's child, systematically.
 */
const assert = require('assert');
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

const axis = (i) => { const v = new Array(512).fill(0); v[i] = 1; return v; };

(async () => {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'parent_corrections' });

  const { Photo, ParentPhotoHidden, ChildFaceReference } = require('../src/models');
  const svc = require('../src/services/parentFaces.service');
  const tagging = require('../src/services/faceTagging.service');

  const dani = new mongoose.Types.ObjectId();
  const maya = new mongoose.Types.ObjectId();
  const parent = new mongoose.Types.ObjectId();
  const room = new mongoose.Types.ObjectId();
  const mine = [dani];

  const mkPhoto = (faces) => Photo.create({
    key: `p/${Math.random().toString(36).slice(2)}.jpg`,
    source: 'staff',
    date: '2026-09-22',
    classroom_id: room,
    width: 1600,
    height: 1200,
    face_scan_status: 'done',
    face_scanned_at: new Date(),
    faces,
    child_ids: faces.filter((f) => f.child_id).map((f) => f.child_id),
  });

  console.log('תיקון של הורה:');

  /* --- "זה לא הילד שלי" — תיקון --- */
  let photo = await mkPhoto([
    { bbox: [0, 0, 90, 90], det_score: 0.9, child_id: dani, confidence: 0.61, embedding: axis(0) },
    { bbox: [200, 0, 290, 90], det_score: 0.9, child_id: maya, confidence: 0.7, embedding: axis(1) },
  ]);
  let r = await svc.notMyChild({ childIds: mine, photoId: photo._id, faceIndex: 0 });
  check('התיקון מתקבל', r.ok, r.reason);
  let after = await Photo.findById(photo._id).lean();
  check('  התג ירד מהפרצוף', after.faces[0].child_id === null);
  check('  ונרשם כהחלטת ההורה', after.faces[0].decided_by === 'parent');
  check('  הילד ירד מהתמונה', !after.child_ids.map(String).includes(String(dani)));
  check('  הילדה האחרת לא נגעה', String(after.faces[1].child_id) === String(maya));

  r = await svc.notMyChild({ childIds: mine, photoId: photo._id, faceIndex: 1 });
  check('אי אפשר לתקן פרצוף של ילד אחר', !r.ok, JSON.stringify(r));

  /* --- "אל תציג לי" — העדפה --- */
  photo = await mkPhoto([
    { bbox: [0, 0, 90, 90], det_score: 0.9, child_id: dani, confidence: 0.8, embedding: axis(0) },
  ]);
  await svc.hide({ parentId: parent, childId: dani, photoId: photo._id });
  after = await Photo.findById(photo._id).lean();
  check('ההסתרה לא נוגעת בתג', String(after.faces[0].child_id) === String(dani));
  check('  ולא משנה את התמונה בכלל', after.child_ids.map(String).includes(String(dani)));
  check('  ולא נרשמת כהחלטה', after.faces[0].decided_by === 'system');
  let hidden = await svc.hiddenIds({ parentId: parent, childIds: mine });
  check('  אבל התמונה מוסתרת אצל ההורה', hidden.has(String(photo._id)));

  await svc.hide({ parentId: parent, childId: dani, photoId: photo._id });
  check('לחיצה כפולה אינה שגיאה',
    (await ParentPhotoHidden.countDocuments({ photo_id: photo._id })) === 1);

  await svc.unhide({ parentId: parent, childId: dani, photoId: photo._id });
  hidden = await svc.hiddenIds({ parentId: parent, childIds: mine });
  check('וניתן לבטל', !hidden.has(String(photo._id)));

  /* --- "זה כן הילד שלי" --- */
  photo = await mkPhoto([
    { bbox: [0, 0, 90, 90], det_score: 0.9, child_id: null, embedding: axis(3) },
    { bbox: [200, 0, 290, 90], det_score: 0.9, child_id: maya, confidence: 0.82, embedding: axis(1) },
  ]);
  r = await svc.isMyChild({
    childId: dani, childIds: mine, photoId: photo._id, faceIndex: 0,
  });
  check('ההוספה מתקבלת', r.ok, r.reason);
  after = await Photo.findById(photo._id).lean();
  check('  הילד נוסף לתמונה', after.child_ids.map(String).includes(String(dani)));
  check('  ומסומן כממתין לאישור צוות', after.faces[0].awaiting_staff === true);
  check('  ועדיין לא נוצרה טביעת ייחוס',
    (await ChildFaceReference.countDocuments({ child_id: dani })) === 0);

  r = await svc.isMyChild({
    childId: dani, childIds: mine, photoId: photo._id, faceIndex: 1,
  });
  check('לא ניתן לתפוס פרצוף שהמערכת בטוחה שהוא ילד אחר', !r.ok && r.flagged === true,
    JSON.stringify(r));

  r = await svc.isMyChild({ childId: maya, childIds: mine, photoId: photo._id, faceIndex: 0 });
  check('ולא לסמן ילד שאינו שלך', !r.ok);

  /* --- אישור הצוות הופך את זה לייחוס --- */
  const claims = await tagging.parentClaims({ classroomIds: [room] });
  check('הסימון מופיע לצוות לאישור', claims.length === 1 && claims[0].face_index === 0,
    JSON.stringify(claims));

  r = await tagging.resolveParentClaim({ photoId: photo._id, faceIndex: 0, agree: true });
  check('הצוות מאשר', r.ok && r.agreed);
  check('  ורק עכשיו נוצרת טביעת ייחוס',
    (await ChildFaceReference.countDocuments({ child_id: dani })) === 1);
  after = await Photo.findById(photo._id).lean();
  check('  והסימון כבר לא ממתין', after.faces[0].awaiting_staff === false);
  const ref = await ChildFaceReference.findOne({ child_id: dani }).lean();
  check('  ומקורה מסומן כהורה', ref.source === 'parent');

  /* --- ודחייה מורידה את התג --- */
  photo = await mkPhoto([{ bbox: [0, 0, 90, 90], det_score: 0.9, child_id: null, embedding: axis(5) }]);
  await svc.isMyChild({ childId: dani, childIds: mine, photoId: photo._id, faceIndex: 0 });
  r = await tagging.resolveParentClaim({ photoId: photo._id, faceIndex: 0, agree: false });
  after = await Photo.findById(photo._id).lean();
  check('דחיית הצוות מורידה את התג', r.ok && !r.agreed && after.faces[0].child_id === null);
  check('  ולא נוצרה טביעה נוספת',
    (await ChildFaceReference.countDocuments({ child_id: dani })) === 1);

  /* --- מה ההורה רשאי לראות על פרצופים של אחרים --- */
  photo = await mkPhoto([
    { bbox: [0, 0, 90, 90], det_score: 0.9, child_id: dani, confidence: 0.7, embedding: axis(0) },
    { bbox: [200, 0, 290, 90], det_score: 0.9, child_id: maya, confidence: 0.8, embedding: axis(1) },
    { bbox: [400, 0, 490, 90], det_score: 0.9, child_id: null, embedding: axis(6) },
  ]);
  const boxes = svc.faceBoxes(await Photo.findById(photo._id).lean(), mine);
  check('פרצוף של ילד אחר אינו נחשף כלל',
    !boxes.some((b) => b.bbox[0] === 200), JSON.stringify(boxes));
  check('  הפרצוף שלי כן', boxes.some((b) => b.is_mine && b.bbox[0] === 0));
  check('  ופרצוף שאיש לא סימן — כן, כדי שאפשר יהיה לסמן',
    boxes.some((b) => !b.taken && b.bbox[0] === 400));

  await mongoose.disconnect();
  await mongod.stop();

  if (failures.length) { console.error(`\nFAIL — ${failures.length} שגויים`); process.exit(1); }
  console.log('\nPASS face-parent-corrections');
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
