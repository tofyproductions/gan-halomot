const sharp = require('sharp');
const {
  Photo, Child, DailyLog, ChildFaceReference,
} = require('../models');
const storage = require('./storage.service');
const { candidateChildIds, expandTwins } = require('./face/matcher');
const { REFERENCES_PER_CHILD, EMBEDDING_TTL_DAYS } = require('./face/constants');
const consent = require('./faceConsent.service');

/**
 * The teachers' tagging queue — the screen the whole feature lives or dies on.
 *
 * Sharing to the class WhatsApp group costs a teacher nothing: photograph,
 * share, done. If naming a face here costs her more than a couple of seconds
 * she will go back to WhatsApp and the gallery will sit empty, however good
 * the recognition is. So everything in this file is shaped by that one number.
 *
 * Which is why the answer is never a search box over 220 children. The system
 * already knows which classroom the photograph belongs to and which children
 * turned up that morning, so the choice is roughly a dozen faces on screen and
 * the interaction is one tap. That list comes from the daily board, built in
 * September for something else entirely.
 *
 * And the work shrinks as it goes. Every name creates a reference, and the
 * scanner back-fills photographs already taken, so a face the teacher names on
 * Monday means the same child is recognised automatically on Tuesday and never
 * reaches this queue again.
 */

// The face crop the teacher sees, with room around it — a face cut exactly to
// the detector's box is a nose and two eyes, and is genuinely harder to
// recognise than the same face with a shoulder and some background.
const CROP_PAD = 0.35;
const CROP_PX = 400;

/**
 * Faces still waiting for a name, easiest first.
 *
 * Ordered by detection confidence rather than by date: a teacher working
 * through a queue gives up on the ambiguous ones, and starting with the clear
 * faces means the references are built from good material. The blurred
 * three-quarter profiles are still there afterwards, and by then the system
 * can often guess them.
 */
async function queue({ classroomIds, limit = 12 }) {
  const rows = await Photo.aggregate([
    {
      $match: {
        classroom_id: { $in: classroomIds },
        source: 'staff',
        face_scan_status: 'done',
      },
    },
    { $unwind: { path: '$faces', includeArrayIndex: 'face_index' } },
    {
      $match: {
        'faces.child_id': null,
        'faces.not_a_child': { $ne: true },
        // A face whose numbers have been purged — or never stored, because no
        // parent in the room consented — cannot become a reference, so naming
        // it would teach the system nothing. It stays in the gallery, it
        // simply leaves this queue. `.0` rather than the array field itself:
        // `embedding` can exist as `[]` (never observed today, but nothing
        // guarantees it never will), and an empty array is not a usable one.
        'faces.embedding.0': { $exists: true },
      },
    },
    { $sort: { 'faces.det_score': -1 } },
    { $limit: limit },
    {
      $project: {
        photo_id: '$_id',
        face_index: 1,
        date: 1,
        classroom_id: 1,
        bbox: '$faces.bbox',
        det_score: '$faces.det_score',
      },
    },
  ]);

  return rows.map((r) => ({
    photo_id: String(r.photo_id),
    face_index: r.face_index,
    date: r.date,
    classroom_id: String(r.classroom_id),
    det_score: r.det_score,
    crop_url: `/face-tagging/crop/${r.photo_id}/${r.face_index}`,
  }));
}

/**
 * The buttons: who could this be.
 *
 * Attendance first, the room's roster when the board was not filled in. The
 * fallback is wider rather than wrong — it just gives the teacher more buttons
 * to read on a day nobody marked the board.
 */
async function candidates({ classroomId, date }) {
  const ids = await candidateChildIds({ DailyLog, Child }, {
    classroom_id: classroomId, date,
  });
  if (!ids.length) return [];

  const children = await Child.find({ _id: { $in: ids } })
    .select('child_name twin_group_id')
    .lean();

  // Already-known children first: during the bootstrap week the ones with no
  // references are the ones that still need work, and they belong where the
  // thumb lands.
  const refCounts = await ChildFaceReference.aggregate([
    { $match: { child_id: { $in: children.map((c) => c._id) } } },
    { $group: { _id: '$child_id', n: { $sum: 1 } } },
  ]);
  const counts = new Map(refCounts.map((r) => [String(r._id), r.n]));

  return children
    .map((c) => ({
      id: String(c._id),
      name: c.child_name,
      references: counts.get(String(c._id)) || 0,
    }))
    .sort((a, b) => a.references - b.references || a.name.localeCompare(b.name, 'he'));
}

/**
 * כל הכיתה — מסלול המילוט של הכפתורים.
 *
 * `candidates` למעלה מציג מי שנכח ומי שההורים שלו הסכימו, וזה נכון ברוב
 * המוחלט של הפעמים. אבל זה גם אומר שיכול להישאר כפתור אחד על המסך: בתינוקיה
 * 20 נכחו עשרה ילדים ולשניים בלבד בכל הכיתה יש הסכמה — אז הגננת רואה שם אחד
 * ואין לה שום דרך להגיע לתשעה האחרים.
 *
 * אז כאן חוזרת כל הכיתה, בלי סינון נוכחות ובלי סינון הסכמה, עם דגל שאומר מי
 * מהם ההורים לא הסכימו. התיוג עצמו מותר גם בלי הסכמה — זו הערה של אדם על
 * תמונה, והמשפחה מקבלת את התמונה. מה שלא קורה בלעדיה הוא הלמידה: השרת לא
 * יוצר טביעה, ולכן זה לא מלמד את המערכת כלום. זה בדיוק מה שנקבע מראש.
 */
async function roster({ classroomId }) {
  const children = await Child.find({ classroom_id: classroomId, is_active: { $ne: false } })
    .select('child_name twin_group_id')
    .lean();
  if (!children.length) return [];

  const ids = children.map((c) => c._id);
  const consenting = new Set(
    (await consent.filterConsenting(ids)).map(String),
  );
  const refCounts = await ChildFaceReference.aggregate([
    { $match: { child_id: { $in: ids } } },
    { $group: { _id: '$child_id', n: { $sum: 1 } } },
  ]);
  const counts = new Map(refCounts.map((r) => [String(r._id), r.n]));

  return children
    .map((c) => ({
      id: String(c._id),
      name: c.child_name,
      references: counts.get(String(c._id)) || 0,
      consent: consenting.has(String(c._id)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'he'));
}

/**
 * The cropped face, rendered on the fly.
 *
 * `crop_url` above is relative to the API client's own base, which already
 * ends in /api — repeating it produced /api/api/... and a 404, and the screen
 * showed a broken-image square with nothing to explain it.
 */
async function crop({ photoId, faceIndex }) {
  const photo = await Photo.findById(photoId).select('key faces width height').lean();
  const face = photo && photo.faces && photo.faces[faceIndex];
  if (!face) return null;

  const buffer = await storage.getObject(photo.key);
  const [x1, y1, x2, y2] = face.bbox;
  const pad = Math.round(CROP_PAD * Math.max(x2 - x1, y2 - y1));

  const image = sharp(buffer, { failOn: 'none' }).rotate();
  const meta = await image.metadata();
  const w = meta.autoOrient?.width ?? meta.width;
  const h = meta.autoOrient?.height ?? meta.height;

  const left = Math.max(0, x1 - pad);
  const top = Math.max(0, y1 - pad);
  return image
    .extract({
      left,
      top,
      width: Math.min(w - left, (x2 - x1) + pad * 2),
      height: Math.min(h - top, (y2 - y1) + pad * 2),
    })
    .resize(CROP_PX, CROP_PX, { fit: 'cover' })
    .jpeg({ quality: 82 })
    .toBuffer();
}

/** Twin id -> the others sharing it, for a given set of children. */
async function twinsFor(childIds) {
  const kids = await Child.find({ _id: { $in: childIds }, twin_group_id: { $ne: null } })
    .select('twin_group_id').lean();
  const groups = [...new Set(kids.map((k) => k.twin_group_id))];
  if (!groups.length) return new Map();

  const all = await Child.find({ twin_group_id: { $in: groups } })
    .select('twin_group_id').lean();
  const byGroup = new Map();
  for (const c of all) {
    if (!byGroup.has(c.twin_group_id)) byGroup.set(c.twin_group_id, []);
    byGroup.get(c.twin_group_id).push(String(c._id));
  }
  const map = new Map();
  for (const group of byGroup.values()) {
    for (const id of group) map.set(id, group.filter((o) => o !== id));
  }
  return map;
}

/**
 * A teacher names a face.
 *
 * Two things happen and the second is the point: the photograph gets its tag,
 * and the face becomes a reference. Without the reference this is data entry;
 * with it, the same child is recognised for free from tomorrow and the queue
 * gets shorter every time someone uses it.
 */
async function nameFace({ photoId, faceIndex, childId, user }) {
  const photo = await Photo.findById(photoId).select('+faces.embedding');
  if (!photo) return { ok: false, reason: 'photo not found' };

  const face = photo.faces[faceIndex];
  if (!face) return { ok: false, reason: 'face not found' };

  face.child_id = childId;
  face.decided_by = 'staff';
  // Deliberately null, not 1: this is a person's answer, not a measurement,
  // and writing a similarity here would make a human decision look like a
  // confident machine one in every screen that reads this field.
  face.confidence = null;
  face.not_a_child = false;

  const twins = await twinsFor([childId]);
  const tagged = new Set((photo.child_ids || []).map(String));
  for (const id of expandTwins([childId], twins)) tagged.add(id);
  photo.child_ids = [...tagged];

  await photo.save();

  // The embedding survives only for EMBEDDING_TTL_DAYS, and a face whose
  // numbers are already gone can still be tagged — it just cannot teach.
  // Neither can one whose family did not agree to face recognition: the tag is
  // a person's note about a photograph, the template is biometric data about a
  // minor, and only the second needs permission.
  const mayTeach = await consent.mayStoreReference(childId);
  if (mayTeach && face.embedding && face.embedding.length) {
    await ChildFaceReference.create({
      child_id: childId,
      embedding: face.embedding,
      source_photo: photo._id,
      source: 'staff',
      det_score: face.det_score,
      branch_id: photo.branch_id,
    });
    await ChildFaceReference.trim(childId);
  }

  // Named as a child whose family did not agree: the tag stands — it is a
  // person's note about a photograph — but the 512 numbers have no purpose
  // here and no permission, so they go now rather than waiting out the TTL.
  if (!mayTeach) {
    await Photo.updateOne({ _id: photo._id },
      { $unset: { [`faces.${faceIndex}.embedding`]: '' } });
  }

  const references = await ChildFaceReference.countDocuments({ child_id: childId });
  return {
    ok: true,
    references,
    consent: mayTeach,
    // Worth surfacing: a child at the ceiling needs no more naming, which is
    // the signal the bootstrap week is finished for them.
    at_ceiling: references >= REFERENCES_PER_CHILD,
    taught: Boolean(mayTeach && face.embedding && face.embedding.length),
  };
}

/**
 * Not a child at all — an ear, the back of a head, a doll on the shelf.
 *
 * Marked rather than deleted so the queue does not offer it again tomorrow,
 * and kept on the row so a pattern of them is visible: a lot of these from one
 * classroom usually means a poster on the wall the detector keeps finding.
 */
async function markNotAChild({ photoId, faceIndex }) {
  const res = await Photo.updateOne(
    { _id: photoId },
    { $set: { [`faces.${faceIndex}.not_a_child`]: true } },
  );
  return { ok: res.matchedCount > 0 };
}

/**
 * Faces a PARENT claimed, waiting for a member of staff to agree.
 *
 * A parent's tag counts for their own gallery straight away — they can already
 * see the photograph in the classroom gallery, so nothing is revealed by
 * letting them keep it. What it must not do unchecked is become a reference:
 * a parent who taps the wrong face would teach the system another family's
 * child as their own, systematically, and break recognition for both families.
 *
 * So it waits here. Confirming turns it into a reference like any staff tag;
 * rejecting takes it off.
 */
async function parentClaims({ classroomIds, limit = 20 }) {
  const rows = await Photo.aggregate([
    { $match: { classroom_id: { $in: classroomIds }, source: 'staff' } },
    { $unwind: { path: '$faces', includeArrayIndex: 'face_index' } },
    { $match: { 'faces.awaiting_staff': true, 'faces.child_id': { $ne: null } } },
    { $sort: { date: -1 } },
    { $limit: limit },
    {
      $project: {
        photo_id: '$_id', face_index: 1, date: 1, classroom_id: 1,
        child_id: '$faces.child_id', det_score: '$faces.det_score',
      },
    },
  ]);
  if (!rows.length) return [];

  const names = await Child.find({ _id: { $in: rows.map((r) => r.child_id) } })
    .select('child_name').lean();
  const byId = new Map(names.map((n) => [String(n._id), n.child_name]));

  return rows.map((r) => ({
    photo_id: String(r.photo_id),
    face_index: r.face_index,
    date: r.date,
    classroom_id: String(r.classroom_id),
    child_id: String(r.child_id),
    child_name: byId.get(String(r.child_id)) || '',
    crop_url: `/face-tagging/crop/${r.photo_id}/${r.face_index}`,
  }));
}

/** A member of staff agrees with a parent, or does not. */
async function resolveParentClaim({ photoId, faceIndex, agree }) {
  const photo = await Photo.findById(photoId).select('+faces.embedding');
  if (!photo) return { ok: false, reason: 'photo not found' };
  const face = photo.faces[faceIndex];
  if (!face || !face.awaiting_staff) return { ok: false, reason: 'nothing waiting there' };

  const childId = face.child_id;
  face.awaiting_staff = false;

  if (!agree) {
    face.child_id = null;
    face.confidence = null;
    face.decided_by = 'staff';
    const stillThere = photo.faces.some((f) => String(f.child_id) === String(childId));
    if (!stillThere) {
      photo.child_ids = photo.child_ids.filter((id) => String(id) !== String(childId));
    }
    await photo.save();
    return { ok: true, agreed: false };
  }

  // Agreed: it becomes evidence, exactly like a face the teacher named herself.
  face.decided_by = 'staff';
  await photo.save();

  const mayTeachClaim = await consent.mayStoreReference(childId);
  if (mayTeachClaim && face.embedding && face.embedding.length) {
    await ChildFaceReference.create({
      child_id: childId,
      embedding: face.embedding,
      source_photo: photo._id,
      source: 'parent',
      det_score: face.det_score,
      branch_id: photo.branch_id,
    });
    await ChildFaceReference.trim(childId);
  }
  return {
    ok: true,
    agreed: true,
    taught: Boolean(mayTeachClaim && face.embedding && face.embedding.length),
  };
}

/**
 * How much is left, for the teacher and for the branch manager.
 *
 * "waiting" used to mean every unnamed, non-"not a child" face — but a face
 * scanned in a room where no parent has consented to face recognition never
 * gets an embedding (services/face/scanner.js), and without one `queue()`
 * (which requires an embedding) can never offer it. Counting it as "waiting"
 * produced a badge that promised work the tagging screen could never show:
 * "7 ממתינים" next to "אין פרצופים שממתינים". So `waiting` here counts only
 * faces `queue()` can actually hand to a teacher — unnamed, not "not a
 * child", AND with an embedding.
 *
 * The rest of them are missing an embedding for one of two DIFFERENT reasons,
 * and a teacher needs to know which: `no_consent` — nobody in the room agreed
 * to face recognition, so the scanner never stored one (services/face/
 * scanner.js). `expired` — somebody DID agree, and the scanner DID store one,
 * but `facePurgeJob` unsets it EMBEDDING_TTL_DAYS after the photograph was
 * scanned, same as it does for any face that got named in time. Both are
 * equally impossible to auto-recognise now, but "no consent" is a policy fact
 * about a family and "expired" is a fact about how long ago the photo was
 * taken — conflating them would tell a teacher to go chase a permission that
 * was never the problem, or shrug at a family who actually said yes.
 *
 * `faces.embedding` is `select: false` on the schema, which hides it from an
 * ordinary `.find()` — but an aggregation pipeline reads the raw document and
 * is not subject to that projection, so it IS present here. Proven by
 * scripts/face-tagging-progress.test.js.
 */
async function progress({ classroomIds }) {
  const cutoff = new Date(Date.now() - EMBEDDING_TTL_DAYS * 24 * 60 * 60 * 1000);
  const hasEmbedding = { $gt: [{ $size: { $ifNull: ['$faces.embedding', []] } }, 0] };
  const isUnnamed = {
    $and: [
      { $eq: ['$faces.child_id', null] },
      { $ne: ['$faces.not_a_child', true] },
    ],
  };
  // `face_scanned_at` lives on the photograph, not the face — every scan of a
  // photograph stamps it once, at the same moment every face in it gets (or
  // doesn't get) an embedding, so one cutoff comparison covers the whole
  // photograph's faces correctly even after $unwind.
  const isExpired = { $lt: ['$face_scanned_at', cutoff] };
  const missingEmbedding = { $not: [hasEmbedding] };

  const [row] = await Photo.aggregate([
    {
      $match: {
        classroom_id: { $in: classroomIds },
        source: 'staff',
        face_scan_status: 'done',
      },
    },
    { $unwind: '$faces' },
    {
      $group: {
        _id: null,
        faces: { $sum: 1 },
        named: { $sum: { $cond: [{ $ne: ['$faces.child_id', null] }, 1, 0] } },
        not_a_child: { $sum: { $cond: ['$faces.not_a_child', 1, 0] } },
        waiting: { $sum: { $cond: [{ $and: [isUnnamed, hasEmbedding] }, 1, 0] } },
        no_consent: {
          $sum: {
            $cond: [{ $and: [isUnnamed, missingEmbedding, { $not: [isExpired] }] }, 1, 0],
          },
        },
        expired: {
          $sum: {
            $cond: [{ $and: [isUnnamed, missingEmbedding, isExpired] }, 1, 0],
          },
        },
      },
    },
  ]);
  return row
    ? {
      faces: row.faces,
      named: row.named,
      waiting: row.waiting,
      no_consent: row.no_consent,
      expired: row.expired,
      not_a_child: row.not_a_child,
    }
    : {
      faces: 0, named: 0, waiting: 0, no_consent: 0, expired: 0, not_a_child: 0,
    };
}

module.exports = {
  queue, candidates,
  roster, crop, nameFace, markNotAChild, progress,
  parentClaims, resolveParentClaim,
};
