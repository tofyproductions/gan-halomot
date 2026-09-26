const {
  Photo, Child, DailyLog, ChildFaceReference, Setting,
} = require('../../models');
const storage = require('../storage.service');
const engine = require('./index');
const { candidateChildIds, assign, expandTwins } = require('./matcher');
const { EMBEDDING_TTL_DAYS } = require('./constants');

/**
 * The background scanner: one photograph at a time, forever, quietly.
 *
 * SERIAL ON PURPOSE. The gan runs on a single CPU that also serves the app and
 * launches Chromium for the payslip PDFs. Ten teachers uploading their morning
 * at once is a normal Tuesday, and scanning those in parallel would make the
 * whole site unresponsive to save a background job a few minutes it does not
 * need. A photograph takes well under a second of CPU; 400 a day across four
 * branches is around twenty minutes, spread out.
 *
 * OFF BY DEFAULT. The switch is a Setting, so it can be turned on for one
 * branch's worth of testing without a deploy — and turned off the moment it
 * misbehaves, which matters more.
 *
 * NEVER RESCANS. `face_scan_status` moves pending -> done exactly once. A
 * photograph that failed stays failed until someone asks for it again rather
 * than being retried forever, because the two things that make a scan fail —
 * a corrupt file and a missing model — do not get better on their own and a
 * retry loop on a paid CPU is a bill with no upside.
 */

const ENABLED_KEY = 'face_recognition_enabled';
const HEALTH_KEY = 'face_recognition_health';

// Long enough that a backlog drains steadily, short enough that a teacher who
// uploads at pickup sees tags before the parents' evening digest goes out.
const IDLE_MS = 20_000;
const BUSY_MS = 250;

// How long before the same photograph is worth trying again. Long enough that
// the sweep does not spin over the same rows while a teacher is mid-queue,
// short enough that naming a child pays off within the hour.
const REMATCH_COOLDOWN_MS = 30 * 60 * 1000;

let timer = null;
let running = false;

async function isEnabled() {
  const doc = await Setting.findOne({ key: ENABLED_KEY }).lean();
  return Boolean(doc && doc.value && doc.value.on);
}

/**
 * The number that makes a silent death visible.
 *
 * When this stops moving while photographs keep arriving, the queue is stuck —
 * and a stuck queue looks exactly like a quiet week from the outside, which is
 * how three weeks of untagged photographs would otherwise go unnoticed.
 */
async function recordHealth(patch) {
  // Field-by-field rather than replacing `value`, so two facts written at
  // different moments — the last successful scan and the last error — do not
  // erase each other.
  const $set = { key: HEALTH_KEY };
  for (const [k, v] of Object.entries(patch)) $set[`value.${k}`] = v;
  await Setting.updateOne({ key: HEALTH_KEY }, { $set }, { upsert: true });
}

async function health() {
  const doc = await Setting.findOne({ key: HEALTH_KEY }).lean();
  const pending = await Photo.countDocuments({ face_scan_status: 'pending' });
  const failed = await Photo.countDocuments({ face_scan_status: 'failed' });
  const oldest = await Photo.findOne({ face_scan_status: 'pending' })
    .sort({ created_at: 1 }).select('created_at').lean();
  return {
    enabled: await isEnabled(),
    pending,
    failed,
    oldest_pending_at: oldest ? oldest.created_at : null,
    ...(doc ? doc.value : {}),
  };
}

/** Twin id -> the other children sharing it, for the whole gan. Small and cheap. */
async function twinMap() {
  const twins = await Child.find({ twin_group_id: { $ne: null } })
    .select('_id twin_group_id').lean();
  const byGroup = new Map();
  for (const c of twins) {
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
 * Scan one photograph. Returns what happened, for the caller to log or count.
 *
 * Exported so a test and a one-off backfill can drive it directly without the
 * timer — the loop below is only scheduling.
 */
async function scanOne(photo) {
  // A parent's upload is matched only against that parent's own children, and
  // never here: this path knows the whole classroom, which is exactly the
  // knowledge a parent's photograph must not be exposed to. See the Photo
  // model — a birthday picture carries other families' children.
  if (photo.source !== 'staff') {
    await Photo.updateOne({ _id: photo._id },
      { $set: { face_scan_status: 'skipped', face_scanned_at: new Date() } });
    return { status: 'skipped', reason: 'not a staff photograph' };
  }

  const buffer = await storage.getObject(photo.key);
  const { faces } = await engine.analyze(buffer);

  if (!faces.length) {
    await Photo.updateOne({ _id: photo._id },
      { $set: { face_scan_status: 'done', face_scanned_at: new Date(), faces: [] } });
    return { status: 'done', faces: 0, tagged: 0 };
  }

  const candidates = await candidateChildIds({ DailyLog, Child }, photo);
  const references = candidates.length
    ? await ChildFaceReference.find({ child_id: { $in: candidates } })
      .select('child_id embedding').lean()
    : [];

  const decisions = assign(faces, references);

  // A correction outlives a scan. If a person has already decided about a face
  // in this photograph, their answer stays — the scanner is allowed to fill
  // gaps, never to overrule someone who looked.
  const humanByBox = new Map(
    (photo.faces || [])
      .filter((f) => f.decided_by !== 'system')
      .map((f) => [f.bbox.join(','), f]),
  );
  for (const d of decisions) {
    const prior = humanByBox.get(d.bbox.join(','));
    if (prior) {
      d.child_id = prior.child_id;
      d.confidence = prior.confidence;
      d.decided_by = prior.decided_by;
    }
  }

  /**
   * Carry the numbers — but only where somebody agreed to that.
   *
   * A teacher naming an unmatched face needs them to build a reference from
   * it, and a child enrolled next month needs them to be found in photographs
   * already scanned, so they are kept for EMBEDDING_TTL_DAYS and then purged.
   *
   * `candidates` has already been through the consent filter: it is the
   * children in this room whose families agreed to face recognition. When it
   * is empty, nothing in this photograph could ever be matched or taught, and
   * storing an embedding would be keeping biometric data about children for a
   * purpose nobody consented to and no feature could use. So it is not stored.
   * The faces are still found, the photograph still reaches the classroom
   * gallery, and a teacher can still tag it by hand.
   */
  if (candidates.length) {
    decisions.forEach((d, i) => { d.embedding = Array.from(faces[i].embedding); });
  }

  const twins = await twinMap();
  const childIds = expandTwins(
    decisions.filter((d) => d.child_id).map((d) => d.child_id),
    twins,
  );

  await Photo.updateOne({ _id: photo._id }, {
    $set: {
      faces: decisions,
      child_ids: childIds,
      face_scan_status: 'done',
      face_scanned_at: new Date(),
      face_scan_error: '',
    },
  });

  return { status: 'done', faces: faces.length, tagged: childIds.length };
}

/**
 * Try the unnamed faces again, now that more is known.
 *
 * During the bootstrap week a child has no references, so nothing can match
 * them and every one of their faces lands in the teacher's queue. The moment
 * she names the first one, the system could recognise that child in all the
 * photographs already taken — but those are marked done and would never be
 * looked at again.
 *
 * So when the main queue is empty, this goes back over faces that are still
 * unnamed and still have their numbers, and matches them against the
 * references that exist now. It is what makes the teacher's work shrink as she
 * does it rather than only paying off tomorrow.
 *
 * Runs on one photograph at a time, like everything else here.
 */
async function rematchOne() {
  const photo = await Photo.findOne({
    face_scan_status: 'done',
    faces: {
      $elemMatch: {
        child_id: null,
        not_a_child: { $ne: true },
        embedding: { $exists: true },
      },
    },
    // Only worth revisiting while the numbers are still around; after the
    // purge there is nothing to match with.
    face_scanned_at: { $gte: new Date(Date.now() - EMBEDDING_TTL_DAYS * 86400_000) },
    face_rematched_at: { $lt: new Date(Date.now() - REMATCH_COOLDOWN_MS) },
  }).select('+faces.embedding').sort({ face_rematched_at: 1 }).lean();

  if (!photo) return false;

  const open = photo.faces
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => !f.child_id && !f.not_a_child && f.embedding && f.embedding.length);

  const candidates = await candidateChildIds({ DailyLog, Child }, photo);
  // Children already named in THIS photograph cannot be in it twice, so they
  // are out of the running for the faces that are still open.
  const spoken = new Set(photo.faces.filter((f) => f.child_id).map((f) => String(f.child_id)));
  const eligible = candidates.filter((id) => !spoken.has(String(id)));

  const references = eligible.length
    ? await ChildFaceReference.find({ child_id: { $in: eligible } })
      .select('child_id embedding').lean()
    : [];

  const stamp = { face_rematched_at: new Date() };
  if (!references.length) {
    await Photo.updateOne({ _id: photo._id }, { $set: stamp });
    return true;
  }

  const decisions = assign(open.map(({ f }) => f), references);
  const found = decisions.filter((d) => d.child_id);
  if (!found.length) {
    await Photo.updateOne({ _id: photo._id }, { $set: stamp });
    return true;
  }

  const set = { ...stamp };
  decisions.forEach((d, n) => {
    if (!d.child_id) return;
    set[`faces.${open[n].i}.child_id`] = d.child_id;
    set[`faces.${open[n].i}.confidence`] = d.confidence;
  });

  const twins = await twinMap();
  const childIds = expandTwins(
    [...photo.child_ids.map(String), ...found.map((d) => d.child_id)],
    twins,
  );
  set.child_ids = childIds;

  await Photo.updateOne({ _id: photo._id }, { $set: set });
  return true;
}

/** Take the oldest unscanned photograph, if the switch is on. Returns true if it worked. */
async function tick() {
  if (!await isEnabled()) return false;

  // Crashed claims first: a 'scanning' older than the window is a scan that
  // died mid-flight (deploy, OOM) — back to the queue, nothing lost.
  await Photo.updateMany(
    { face_scan_status: 'scanning', face_scan_claimed_at: { $lt: new Date(Date.now() - 10 * 60 * 1000) } },
    { $set: { face_scan_status: 'pending', face_scan_claimed_at: null } },
  ).catch(() => {});

  // ATOMIC CLAIM, not findOne-then-scan: two processes (the old+new instance
  // a deploy runs side by side, or any future scale-up) used to pick the same
  // oldest photo and both pay the models for it. Whoever's update lands owns
  // the photo; the loser gets the next one.
  const photo = await Photo.findOneAndUpdate(
    { face_scan_status: 'pending' },
    { $set: { face_scan_status: 'scanning', face_scan_claimed_at: new Date() } },
    { sort: { created_at: 1 }, new: true },
  ).lean();
  // Nothing new to scan is the moment to go back over what could not be named
  // before — never at the same time, because there is one CPU.
  if (!photo) return rematchOne();

  const startedAt = Date.now();
  try {
    const result = await scanOne(photo);
    await recordHealth({ last_scan_at: new Date() });
    if (result.status === 'done') {
      await recordHealth({ last_scan_ms: Date.now() - startedAt });
    }
  } catch (err) {
    // Recorded on the row rather than only in the log: by the time anyone
    // investigates, the log line has rotated away and the photograph is still
    // sitting there with no explanation.
    await Photo.updateOne({ _id: photo._id }, {
      $set: {
        face_scan_status: 'failed',
        face_scanned_at: new Date(),
        face_scan_error: String(err.message || err).slice(0, 300),
      },
    });
    await recordHealth({ last_error_at: new Date() });
    console.error('[face] scan failed', photo._id, err.message);
  }
  return true;
}

/**
 * Keep taking work until there is none, then wait.
 *
 * Re-arms with setTimeout only after the previous photograph has finished,
 * rather than on an interval. On a single CPU that is the whole difference
 * between a background job and an outage: setInterval would start the next
 * scan on top of a slow one and keep stacking.
 */
function schedule(ms) {
  timer = setTimeout(run, ms);
  // Does not hold the process open — a one-off script or a test that requires
  // this module should still be able to exit.
  if (timer.unref) timer.unref();
}

async function run() {
  if (!running) return;
  let didWork = false;
  try {
    didWork = await tick();
  } catch (err) {
    console.error('[face] queue error', err.message);
  }
  if (running) schedule(didWork ? BUSY_MS : IDLE_MS);
}

function start() {
  if (running) return;
  running = true;
  schedule(IDLE_MS);
  console.log('[face] scan queue armed (off until the setting is turned on)');
}

function stop() {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
}

module.exports = {
  start, stop, tick, scanOne, health, isEnabled, ENABLED_KEY, HEALTH_KEY,
};
