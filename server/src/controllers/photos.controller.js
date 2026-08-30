const { Photo, Child, Classroom } = require('../models');
const storage = require('../services/storage.service');
const photos = require('../services/photo.service');
const nursery = require('../services/nursery.service');

/**
 * The gan's photographs, from the staff side.
 *
 * Uploading is deliberately separate from tagging. A teacher comes in from the
 * garden with thirty photographs and wants them off her phone; deciding who is
 * in each one is a different task, done sitting down, and forcing them into one
 * step means either the upload waits or the tagging never happens.
 *
 * So an untagged photograph is a normal state, not an error. It is already
 * visible to the classroom's parents — the gan chose a class gallery — and
 * tagging only adds it to "photographs of my child".
 */

/** Which classrooms this user may act on. Same rule as the daily board. */
async function visibleClassrooms(user) {
  // This year's rooms only. Rooms are never deactivated at year rollover, so
  // without the year filter last year's "קפלן — תינוקייה א" showed up as an
  // indistinguishable duplicate of this year's.
  const { getAcademicYears } = require('../services/academic-year.service');
  const rooms = await Classroom.find({
    is_active: true,
    academic_year: getAcademicYears().current.range,
  }).populate('branch_id', 'name').lean();
  if (user.role === 'system_admin' || user.role === 'accountant') return rooms;

  const managed = (user.managed_branch_ids || []).map(String);
  const own = user.branch_id ? [String(user.branch_id)] : [];
  const allowed = new Set([...managed, ...own].filter(Boolean));
  // No branches at all = sees nothing, not everything. The old fallback
  // showed a scope-less account every room in the network.
  if (allowed.size === 0) return [];
  return rooms.filter(r => allowed.has(String(r.branch_id?._id || r.branch_id)));
}

/**
 * GET /api/photos/classrooms — the rooms this user may upload to.
 *
 * The screen used to borrow the nursery board's list, which is infant-rooms
 * only by design — so בוגרים and צעירים could never receive photographs. This
 * is the same list the upload itself authorizes against, all categories.
 */
async function listClassrooms(req, res, next) {
  try {
    const rooms = await visibleClassrooms(req.user);
    res.json({
      classrooms: rooms
        .map(r => ({
          id: String(r._id),
          name: r.name,
          branch: r.branch_id?.name || '',
        }))
        .sort((a, b) => a.branch.localeCompare(b.branch, 'he') || a.name.localeCompare(b.name, 'he')),
    });
  } catch (err) { next(err); }
}

async function assertRoom(user, classroomId) {
  const rooms = await visibleClassrooms(user);
  return rooms.find(r => String(r._id) === String(classroomId)) || null;
}

/**
 * Upload one or more photographs to a classroom.
 *
 * Each file is processed on its own and a failure is reported per file rather
 * than failing the batch: thirty photographs from a phone will occasionally
 * include one the camera never finished writing, and losing the other
 * twenty-nine to it would be absurd.
 */
async function upload(req, res) {
  if (!storage.isConfigured()) {
    return res.status(503).json({ error: 'אחסון התמונות אינו מוגדר. יש לפנות למנהל המערכת.' });
  }

  const room = await assertRoom(req.user, req.body?.classroom_id);
  if (!room) return res.status(403).json({ error: 'אין לך הרשאה לכיתה זו' });

  const files = req.files || [];
  if (files.length === 0) return res.status(400).json({ error: 'לא נבחרו תמונות' });

  const date = nursery.normalizeDateKey(req.body?.date) || nursery.todayKey();
  const branchId = room.branch_id?._id || room.branch_id;
  const prefix = `gan/${branchId}/${date}`;

  const saved = [];
  const failed = [];

  for (const file of files) {
    if (!photos.isAcceptable(file)) {
      failed.push({ name: file.originalname, error: 'קובץ שאינו תמונה, או גדול מדי' });
      continue;
    }
    try {
      const stored = await photos.storeUpload({ buffer: file.buffer, prefix });
      const row = await Photo.create({
        ...stored,
        source: 'staff',
        branch_id: branchId,
        classroom_id: room._id,
        date,
        uploaded_by_user: req.user.id,
        uploaded_by_name: req.user.full_name || '',
      });
      saved.push(row);
    } catch (err) {
      console.error('[photos] upload failed:', err.message);
      failed.push({ name: file.originalname, error: 'לא הצלחנו לעבד את הקובץ' });
    }
  }

  return res.json({
    ok: true,
    saved: saved.length,
    failed,
    photos: await photos.withUrls(saved.map(r => r.toObject())),
  });
}

/**
 * A classroom's photographs, newest first.
 *
 * Staff see everything the gan took. A parent's own upload is NOT in this list
 * by default — it belongs to that family and appears here only when explicitly
 * asked for, so the everyday screen is the gan's own photographs.
 */
async function list(req, res) {
  const room = await assertRoom(req.user, req.query.classroom);
  if (!room) return res.status(403).json({ error: 'אין לך הרשאה לכיתה זו' });

  const query = { classroom_id: room._id };
  query.source = req.query.include_parent === '1' ? { $in: ['staff', 'parent'] } : 'staff';
  if (req.query.date) {
    const d = nursery.normalizeDateKey(req.query.date);
    if (d) query.date = d;
  }
  if (req.query.untagged === '1') query.child_ids = { $size: 0 };

  const rows = await Photo.find(query)
    .sort({ date: -1, created_at: -1 })
    .limit(200)
    .lean();

  const children = await Child.find({ classroom_id: room._id, is_active: true })
    .select('child_name').sort({ child_name: 1 }).lean();

  return res.json({
    classroom: { id: room._id, name: room.name, branch: room.branch_id?.name || '' },
    children: children.map(c => ({ id: c._id, name: c.child_name })),
    photos: storage.isConfigured() ? await photos.withUrls(rows) : rows,
  });
}

/**
 * Say who is in a photograph.
 *
 * Only children of that classroom, checked against the roster rather than
 * trusted from the request — a tag is what puts a photograph into a family's
 * "my child" gallery, so an id from elsewhere would be a photograph delivered
 * to a family it has nothing to do with.
 */
async function tag(req, res) {
  const photo = await Photo.findById(req.params.id);
  if (!photo) return res.status(404).json({ error: 'לא נמצא' });

  const room = await assertRoom(req.user, photo.classroom_id);
  if (!room) return res.status(403).json({ error: 'אין לך הרשאה לכיתה זו' });

  if (Array.isArray(req.body?.child_ids)) {
    const roster = await Child.find({ classroom_id: room._id, is_active: true }).select('_id').lean();
    const allowed = new Set(roster.map(c => String(c._id)));
    photo.child_ids = req.body.child_ids
      .map(String)
      .filter(id => allowed.has(id))
      .slice(0, 40);
  }
  if (typeof req.body?.caption === 'string') {
    photo.caption = req.body.caption.trim().slice(0, 200);
  }
  await photo.save();

  return res.json({ ok: true, child_ids: photo.child_ids, caption: photo.caption });
}

/**
 * Remove a photograph, bytes and all.
 *
 * The row goes whether or not the object does. A storage failure that left the
 * row behind would show the staff a photograph they had just deleted, and the
 * orphaned object is invisible to everyone — the wrong half to keep.
 */
async function remove(req, res) {
  const photo = await Photo.findById(req.params.id);
  if (!photo) return res.status(404).json({ error: 'לא נמצא' });

  const room = await assertRoom(req.user, photo.classroom_id);
  if (!room) return res.status(403).json({ error: 'אין לך הרשאה לכיתה זו' });

  try {
    await storage.deleteObject(photo.key);
    if (photo.thumb_key) await storage.deleteObject(photo.thumb_key);
  } catch (err) {
    console.error('[photos] storage delete failed:', err.message);
  }
  await photo.deleteOne();

  return res.json({ ok: true });
}

/**
 * Does the storage actually work, and if not, why.
 *
 * "ההעלאה נכשלה" is a message that hides the answer. An upload touches four
 * things that can each fail on their own — configuration, the image library,
 * the write, the signed read — and from the outside all four look identical.
 *
 * So this runs them in order against a tiny generated image and reports where
 * it stopped, with the provider's own words. It is a diagnostic rather than a
 * guess, and it costs one 8x8 pixel object that it deletes on the way out.
 */
async function selftest(_req, res) {
  const steps = [];
  const step = (name, ok, detail = '') => steps.push({ name, ok, detail });

  const configured = storage.isConfigured();
  step('הגדרות אחסון', configured, configured ? '' : 'חסרים משתני סביבה');
  if (!configured) return res.json({ ok: false, steps });

  let buf;
  try {
    const sharp = require('sharp');
    buf = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .jpeg().toBuffer();
    step('עיבוד תמונה', true, `sharp ${require('sharp/package.json').version}`);
  } catch (err) {
    step('עיבוד תמונה', false, err.message);
    return res.json({ ok: false, steps });
  }

  const key = storage.makeKey('selftest', 'jpg');
  try {
    await storage.putObject({ key, body: buf, contentType: 'image/jpeg' });
    step('כתיבה לאחסון', true, key);
  } catch (err) {
    step('כתיבה לאחסון', false, `${err.name || ''}: ${err.message}`);
    return res.json({ ok: false, steps });
  }

  try {
    const url = await storage.signedReadUrl(key, 60);
    const head = await fetch(url, { method: 'GET' });
    step('קריאה בקישור חתום', head.ok, head.ok ? '' : `HTTP ${head.status}`);
  } catch (err) {
    step('קריאה בקישור חתום', false, err.message);
  }

  try {
    await storage.deleteObject(key);
    step('מחיקה', true);
  } catch (err) {
    step('מחיקה', false, err.message);
  }

  return res.json({ ok: steps.every(s => s.ok), steps });
}

module.exports = { upload, list, tag, remove, selftest, visibleClassrooms, listClassrooms };
