const { Photo, Child, Classroom } = require('../models');
const {
  CLASSROOM_BOARD, CLASSROOM_SCOPED_ROLES, BRANCH_MANAGING_ROLES,
} = require('../constants/roles');
const storage = require('../services/storage.service');
const photos = require('../services/photo.service');
const nursery = require('../services/nursery.service');
const tagging = require('../services/faceTagging.service');

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
  // Each branch's newest rooms — NOT "the current calendar year", which in
  // late August hides every branch that hasn't opened next year's rooms yet.
  // See services/classroomList.js.
  const { dedupeNewest } = require('../services/classroomList');
  const rooms = dedupeNewest(
    await Classroom.find({ is_active: true }).populate('branch_id', 'name').lean(),
  );
  // A board account is ONE room — the same rule as the daily board, and for
  // the same reason: the tablet on that wall photographs that room.
  if (user.role === CLASSROOM_BOARD) {
    const mine = String(user.classroom_id || '');
    return mine ? rooms.filter(r => String(r._id) === mine) : [];
  }

  if (user.role === 'system_admin' || user.role === 'accountant') return rooms;

  /**
   * `managed_branch_ids` הוא שדה של הנהלה. על שורה של גננת הוא רעש שנשאר
   * שם, ולצרף אותו היה נותן לה לראות כיתות בסניף שהיא לא עובדת בו — בדיוק
   * ההפך מהכוונה. אצל מי שלא מנהל סניפים, השיוך הוא הסניף שלו.
   */
  const managed = BRANCH_MANAGING_ROLES.includes(user.role)
    ? (user.managed_branch_ids || []).map(String)
    : [];
  const own = user.branch_id ? [String(user.branch_id)] : [];
  const allowed = new Set([...managed, ...own].filter(Boolean));
  // No branches at all = sees nothing, not everything. The old fallback
  // showed a scope-less account every room in the network.
  if (allowed.size === 0) return [];
  const inBranch = rooms.filter(r => allowed.has(String(r.branch_id?._id || r.branch_id)));

  /**
   * גננת רואה את הכיתות שלה — לא את כל הסניף.
   *
   * כל הצוות של אותה כיתה מעלה ורואה את אותן תמונות, וזה בדיוק מה שצריך:
   * מי שהיה בחדר הוא מי שיודע מה קרה בו. אבל סייעת בתינוקייה לא צריכה את
   * גלריית הבוגרים, ומסך שמציע לה חמש כיתות הוא מסך שממנו היא תעלה לכיתה
   * הלא נכונה מתישהו.
   *
   * הרשימה עוקפת את סינון הסניף במכוון: גננת יכולה לעבוד בשתי כיתות בשני
   * סניפים, וההרשאה לסניפים האלה נגזרת מאותן כיתות ב-utils/branch-scope, כך
   * שהשתיים לא יכולות לסתור.
   *
   * ריקה — חוזרים לסניף. עדיף גננת שרואה יותר מדי מגננת שננעלה בגלל שדה
   * שטרם מולא.
   */
  if (CLASSROOM_SCOPED_ROLES.includes(user.role)) {
    const mine = new Set((user.classroom_ids || []).map(String));
    if (mine.size) {
      // מתוך `rooms` ולא מתוך `inBranch`: כיתה בסניף שני היא מקרה אמיתי,
      // והסניף שלה כבר נכלל בהרשאה בזכות אותו שיוך.
      const hit = rooms.filter(r => mine.has(String(r._id)));
      if (hit.length) return hit;
    }
  }

  return inBranch;
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
  const duplicates = [];

  for (const file of files) {
    if (!photos.isAcceptable(file)) {
      failed.push({ name: file.originalname, error: 'קובץ שאינו תמונה, או גדול מדי' });
      continue;
    }
    try {
      const stored = await photos.storeUpload({ buffer: file.buffer, prefix });

      /**
       * אותה תמונה פעמיים — לא שגיאה, וגם לא סיבה לשמור אותה שוב.
       *
       * קורה כל הזמן: הגננת בוחרת שוב את כל הגליל כי היא לא זוכרת מה כבר
       * העלתה, או לוחצת שלח פעמיים כשהרשת איטית. פעם שעברה זה היה מייצר עוד
       * שורה, עוד שני אובייקטים בדלי, ועוד סריקת פנים — ושתי תמונות זהות
       * בגלריה של ההורה.
       *
       * הבדיקה היא על התוכן אחרי הכיווץ, ולא על שם הקובץ או על EXIF: את
       * המטא-דאטה הצינור הזה מוחק בכוונה (קואורדינטות GPS), ושם קובץ מטלפון
       * לא אומר כלום.
       *
       * ההעלאה עצמה כבר קרתה — היא זו שמייצרת את החתימה — אז מה שנשאר הוא
       * לנקות את מה שהרגע כתבנו ולדווח. אובייקט יתום בדלי הוא בדיוק סוג
       * הזבל שאף אחד לא ימצא אחר כך.
       */
      const twin = await Photo.findOne({
        classroom_id: room._id, sha256: stored.sha256,
      }).select('_id').lean();

      if (twin) {
        await storage.deleteObject(stored.key).catch(() => {});
        if (stored.thumb_key) await storage.deleteObject(stored.thumb_key).catch(() => {});
        duplicates.push({ name: file.originalname, existing_id: String(twin._id) });
        continue;
      }

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
      console.error('[photos] upload failed:', file.originalname, err.message);
      /**
       * HEIC מאייפון, וזה לא מקרה נדיר.
       *
       * הספרייה שקוראת תמונות כאן לא מצליחה לפתוח קובץ HEIC של אייפון מודרני
       * — "Number of references in iref box exceeds the limit of 16", כי
       * התמונה נושאת מפת HDR ומפת עומק. נבדקו שמונה קבצים מאייפון אמיתי,
       * ושמונה מתוכם נכשלו. אי אפשר להעלות את המגבלה מכאן.
       *
       * האפליקציה ממירה ל-JPEG לפני השליחה, ולכן זה לא אמור להגיע — אבל
       * גרסה ישנה שעל טלפון של מישהי כן תשלח כך, וההודעה חייבת להגיד את
       * הסיבה ולא "לא הצלחנו לעבד את הקובץ".
       */
      const heic = /heif|heic/i.test(err.message || '') || /\.hei[cf]$/i.test(file.originalname || '');
      failed.push({
        name: file.originalname,
        error: heic
          ? 'קובץ HEIC שאי אפשר לקרוא. עדכנו את האפליקציה, או העבירו את המצלמה ל"תואם ביותר".'
          : 'לא הצלחנו לעבד את הקובץ',
      });
    }
  }

  return res.json({
    ok: true,
    saved: saved.length,
    failed,
    duplicates,
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
 * סימון או מחיקה של כמה תמונות בבת אחת.
 *
 * גננת שחוזרת מהחצר עם ארבעים תמונות שכולן של אותה קבוצת ילדים לא אמורה
 * לפתוח ארבעים דיאלוגים. וגם: ארבעים בקשות רשת נפרדות על וויפי של גן הן
 * ארבעים הזדמנויות שאחת תיפול באמצע ותשאיר חצי עבודה.
 *
 * `mode: 'add'` הוא ברירת המחדל ולא במקרה. תמונות שונות כבר נושאות סימונים
 * שונים, ו'replace' על בחירה מרובה היה מוחק את מה שכבר סומן בכל אחת מהן —
 * הרס שקט שאי אפשר לבטל. מי שבאמת מתכוון להחליף מבקש זאת במפורש.
 *
 * הסימון הקבוצתי **לא מלמד את זיהוי הפנים**: הוא אומר מי בתמונה, לא איזה
 * פרצוף בה הוא מי. טביעת ייחוס נבנית רק מתיוג של פרצוף מסוים, במסך "מי זה?".
 */
async function bulkTag(req, res) {
  const ids = (req.body?.photo_ids || []).slice(0, 200);
  const childIds = (req.body?.child_ids || []).map(String);
  const mode = req.body?.mode === 'replace' ? 'replace' : 'add';
  if (!ids.length) return res.status(400).json({ error: 'לא נבחרו תמונות' });

  const photos_ = await Photo.find({ _id: { $in: ids } });
  let changed = 0;
  let refused = 0;
  let taught = 0;

  for (const photo of photos_) {
    // ההרשאה נבדקת לכל תמונה בנפרד. בחירה מרובה היא בדיוק המקום שבו קל
    // להניח שכולן מאותה כיתה, והמסך אפילו לא מציג אחרות — אבל בקשה אפשר
    // לשלוח גם בלי המסך.
    const room = await assertRoom(req.user, photo.classroom_id);
    if (!room) { refused += 1; continue; }

    const roster = await Child.find({ classroom_id: room._id, is_active: true })
      .select('_id').lean();
    const allowed = new Set(roster.map(c => String(c._id)));
    const incoming = childIds.filter(id => allowed.has(id));

    const before = photo.child_ids.map(String);
    const next = mode === 'replace'
      ? incoming
      : [...new Set([...before, ...incoming])];

    photo.child_ids = next.slice(0, 40);
    await photo.save();
    changed += 1;

    /**
     * המקרה היחיד שבו בחירה מרובה יכולה גם ללמד.
     *
     * תיוג מהגלריה אומר "הילד הזה בתמונה" ולא "זה הפרצוף שלו", ובתמונה עם
     * ארבעה אנשים אין דרך לדעת על מי מדובר — ולכן היא לא יוצרת טביעה ולא
     * מלמדת כלום. זה הפתיע: עשר תמונות היו מתויגות לילד ורק שמונה לימדו.
     *
     * אבל כשנשאר פרצוף אחד בלי שם ונוסף ילד אחד, אין שום עמימות: הפרצוף הזה
     * הוא הילד הזה. אז במקרה הזה בלבד זה עובר דרך אותו מסלול כמו "מי זה?",
     * עם אותה בדיקת הסכמה ואותה תקרה. שני פרצופים או שני ילדים — לא נוגעים.
     */
    const added = incoming.filter((id) => !before.includes(id));
    const openFaces = (photo.faces || [])
      .map((f, i) => ({ f, i }))
      .filter(({ f }) => !f.child_id && !f.not_a_child);
    const onOtherFace = added.length === 1
      && (photo.faces || []).some((f) => String(f.child_id || '') === added[0]);

    if (added.length === 1 && openFaces.length === 1 && !onOtherFace) {
      const out = await tagging.nameFace({
        photoId: photo._id,
        faceIndex: openFaces[0].i,
        childId: added[0],
      });
      if (out.taught) taught += 1;
    }
  }

  return res.json({
    ok: true, changed, refused, taught,
  });
}

async function bulkRemove(req, res) {
  const ids = (req.body?.photo_ids || []).slice(0, 200);
  if (!ids.length) return res.status(400).json({ error: 'לא נבחרו תמונות' });

  const photos_ = await Photo.find({ _id: { $in: ids } });
  let deleted = 0;
  let refused = 0;

  for (const photo of photos_) {
    const room = await assertRoom(req.user, photo.classroom_id);
    if (!room) { refused += 1; continue; }

    // הבייטים לפני השורה, ואם האחסון נכשל — השורה יורדת בכל זאת. שורה
    // ששרדה מחיקה מציגה לגננת תמונה שהיא הרגע מחקה; אובייקט יתום לא מציג
    // כלום לאף אחד. זו החצי הנכון לוותר עליו.
    try {
      await storage.deleteObject(photo.key);
      if (photo.thumb_key) await storage.deleteObject(photo.thumb_key);
    } catch (err) {
      console.error('[photos] bulk delete storage failed:', photo._id, err.message);
    }
    await Photo.deleteOne({ _id: photo._id });
    deleted += 1;
  }

  return res.json({ ok: true, deleted, refused });
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

// `visibleClassrooms` is also used by the face-tagging screen, which has to
// answer exactly the same question — which rooms may this person act on — and
// must not answer it differently.
module.exports = {
  upload, list, tag, remove, selftest, visibleClassrooms, listClassrooms,
  bulkTag, bulkRemove,
};
