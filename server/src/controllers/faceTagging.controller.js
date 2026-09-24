const { Photo, Child } = require('../models');
const { visibleClassrooms } = require('./photos.controller');
const tagging = require('../services/faceTagging.service');

/**
 * The teachers' tagging screen, server side.
 *
 * Scoped exactly like the photo screen and for the same reason: a teacher
 * tagging faces is looking at children, and the rule for which children she
 * may look at already exists. Borrowing `visibleClassrooms` rather than
 * writing a second rule is the point — two implementations of "whose room is
 * this" drift, and the one that drifts is the one nobody is testing.
 */

/**
 * The rooms this person may tag in — as ObjectIds, which is the whole point.
 *
 * Returning the id off the matched room rather than echoing back what the
 * query string said. An aggregation pipeline does no casting, so a `$match` on
 * classroom_id given the string form of an id matches nothing at all: the
 * screen would answer "no faces waiting" forever, with a 200 and no error
 * anywhere. Caught by face-tagging-e2e.test.js.
 *
 * `requestedList`, when given, narrows to those specific rooms — it is how
 * "כל הכיתות של הסניף" on the tagging screen stays inside the chosen branch
 * instead of falling back to every room this person may act on at all.
 */
async function scopeIds(user, requested, requestedList) {
  const rooms = await visibleClassrooms(user);
  if (requestedList && requestedList.length) {
    const wanted = new Set(requestedList.map(String));
    return rooms.filter((r) => wanted.has(String(r._id))).map((r) => r._id);
  }
  if (requested) {
    const hit = rooms.find((r) => String(r._id) === String(requested));
    return hit ? [hit._id] : [];
  }
  return rooms.map((r) => r._id);
}

/** GET /api/face-tagging/queue?classroom_id=&classroom_ids=&limit= */
async function getQueue(req, res, next) {
  try {
    const classroomIds = String(req.query.classroom_ids || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    const ids = await scopeIds(req.user, req.query.classroom_id, classroomIds);
    if (!ids.length) return res.json({ faces: [], progress: null });

    const limit = Math.min(Number(req.query.limit) || 12, 30);
    const [faces, progress] = await Promise.all([
      tagging.queue({ classroomIds: ids, limit }),
      tagging.progress({ classroomIds: ids }),
    ]);
    return res.json({ faces, progress });
  } catch (e) { return next(e); }
}

/**
 * GET /api/face-tagging/candidates?classroom_id=&date=[&all=1]
 *
 * בלי `all` — מי שנכח ומי שההורים שלו הסכימו, כלומר הכפתורים עצמם. עם `all`
 * — כל הכיתה, למקרה שהילד שבתמונה לא ברשימה הקצרה.
 */
async function getCandidates(req, res, next) {
  try {
    const { classroom_id: classroomId, date, all } = req.query;
    const ids = await scopeIds(req.user, classroomId);
    if (!ids.length) return res.status(403).json({ error: 'לא ניתן לתייג בכיתה הזו' });
    // בלי כיתה מפורשת `ids` הוא כל הכיתות שמותרות לה, ורשימה של כמה כיתות
    // אינה מה שהמסך הזה מבקש. `ids[0]` ולא המחרוזת מהשאילתה — אותה סיבה
    // שבגללה `scopeIds` מחזיר את המזהה מהחדר שנמצא ולא מהדפדפן.
    if (all === '1' && !classroomId) {
      return res.status(400).json({ error: 'צריך לבחור כיתה' });
    }
    const children = all === '1'
      ? await tagging.roster({ classroomId: ids[0] })
      : await tagging.candidates({ classroomId, date });
    return res.json({ children });
  } catch (e) { return next(e); }
}

/**
 * GET /api/face-tagging/crop/:photoId/:faceIndex
 *
 * Rendered on demand rather than stored. Writing a cropped face per detection
 * would mean a second object in the bucket for every child in every
 * photograph — a purpose-built collection of close-ups of children, which is
 * precisely the artefact this design spends its effort not creating. Cutting
 * it out of the photograph that already exists costs a few milliseconds.
 */
async function getCrop(req, res, next) {
  try {
    const { photoId, faceIndex } = req.params;
    const photo = await Photo.findById(photoId).select('classroom_id').lean();
    if (!photo) return res.status(404).end();

    const ids = await scopeIds(req.user, photo.classroom_id);
    if (!ids.length) return res.status(403).end();

    const buffer = await tagging.crop({ photoId, faceIndex: Number(faceIndex) });
    if (!buffer) return res.status(404).end();

    res.set('Content-Type', 'image/jpeg');
    // Private and short-lived: the same reasoning as the gallery's signed
    // links. A face crop cached by a shared proxy outlives the permission that
    // produced it.
    res.set('Cache-Control', 'private, max-age=300');
    return res.send(buffer);
  } catch (e) { return next(e); }
}

/** POST /api/face-tagging/:photoId/:faceIndex  { child_id } | { not_a_child: true } */
async function decide(req, res, next) {
  try {
    const { photoId, faceIndex } = req.params;
    const photo = await Photo.findById(photoId).select('classroom_id').lean();
    if (!photo) return res.status(404).json({ error: 'תמונה לא נמצאה' });

    const ids = await scopeIds(req.user, photo.classroom_id);
    if (!ids.length) return res.status(403).json({ error: 'לא ניתן לתייג בכיתה הזו' });

    if (req.body.not_a_child) {
      return res.json(await tagging.markNotAChild({ photoId, faceIndex: Number(faceIndex) }));
    }

    const childId = req.body.child_id;
    if (!childId) return res.status(400).json({ error: 'לא נבחר ילד' });

    // The child must be one this person may act on — the classroom scope above
    // covers the photograph, not the name being attached to it.
    const child = await Child.findById(childId).select('classroom_id').lean();
    if (!child) return res.status(404).json({ error: 'ילד לא נמצא' });
    const childScope = await scopeIds(req.user, child.classroom_id);
    if (!childScope.length) return res.status(403).json({ error: 'הילד אינו בכיתה שלך' });

    const result = await tagging.nameFace({
      photoId, faceIndex: Number(faceIndex), childId, user: req.user,
    });
    return res.status(result.ok ? 200 : 400).json(result);
  } catch (e) { return next(e); }
}

/** GET /api/face-tagging/parent-claims */
async function getParentClaims(req, res, next) {
  try {
    const ids = await scopeIds(req.user, req.query.classroom_id);
    if (!ids.length) return res.json({ claims: [] });
    return res.json({ claims: await tagging.parentClaims({ classroomIds: ids }) });
  } catch (e) { return next(e); }
}

/** POST /api/face-tagging/parent-claims/:photoId/:faceIndex  { agree } */
async function resolveClaim(req, res, next) {
  try {
    const { photoId, faceIndex } = req.params;
    const photo = await Photo.findById(photoId).select('classroom_id').lean();
    if (!photo) return res.status(404).json({ error: 'תמונה לא נמצאה' });
    const ids = await scopeIds(req.user, photo.classroom_id);
    if (!ids.length) return res.status(403).json({ error: 'לא ניתן לתייג בכיתה הזו' });

    const result = await tagging.resolveParentClaim({
      photoId, faceIndex: Number(faceIndex), agree: Boolean(req.body.agree),
    });
    return res.status(result.ok ? 200 : 400).json(result);
  } catch (e) { return next(e); }
}

module.exports = {
  getQueue, getCandidates, getCrop, decide, getParentClaims, resolveClaim,
};
