/**
 * ביטול העלאה — reversing one EnrollmentImport batch, exactly.
 *
 * Both importers (the ministry's list and ClickTac's two exports) write three
 * kinds of change: rows created, rows altered, rows marked gone. A batch that
 * recorded `created_ids` and `snapshots` can be reversed by deleting the first
 * and putting the second back. A batch from before those fields existed can
 * only be reversed on the CREATE side, by the one thing an older batch does
 * leave behind: the rows whose `first_seen_at` sits inside the upload's own
 * minute and whose source file is the batch's file.
 *
 * ONLY THE LATEST BATCH OF ITS KIND. A snapshot is the row as it was before
 * THIS file; if another file has since touched the row, restoring the snapshot
 * would also erase that later file's work. So the caller is refused when a
 * newer batch exists for the same branch, year, source and export type, and
 * the office undoes uploads from the most recent backwards.
 */

const { EnrollmentImport } = require('../models');

/** Fields a snapshot carries — everything but the sheet row itself. */
const SNAPSHOT_OMIT = new Set(['_id', '__v', 'raw', 'created_at', 'updated_at']);

function snapshotOf(doc) {
  const obj = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  const before = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SNAPSHOT_OMIT.has(k)) continue;
    before[k] = v;
  }
  return { id: obj._id, before };
}

/**
 * Collect snapshots while an import runs, without the importer having to know
 * the cap or the dedupe. One entry per row: the FIRST time the row is touched
 * in this batch is the state before the batch.
 */
function snapshotCollector(cap = 300) {
  const seen = new Set();
  const list = [];
  return {
    take(doc) {
      const key = String(doc._id);
      if (seen.has(key) || list.length >= cap) return;
      seen.add(key);
      list.push(snapshotOf(doc));
    },
    get list() { return list; },
  };
}

/**
 * The filter that finds a batch's created rows when it did not record them.
 *
 * `first_seen_at` is set to the importer's single `now` for every row a batch
 * creates, and `now` is taken before the loop — so it is a few seconds BEFORE
 * the batch's own `created_at`. A window of five minutes back and one forward
 * covers the slowest import seen and nothing that happened an hour earlier.
 */
function legacyCreatedFilter(batch, extra = {}) {
  const at = new Date(batch.created_at).getTime();
  return {
    branch_id: batch.branch_id,
    academic_year: batch.academic_year,
    'presence.first_seen_at': { $gte: new Date(at - 5 * 60 * 1000), $lte: new Date(at + 60 * 1000) },
    ...extra,
  };
}

/**
 * Reverse a batch against `Model` (TmtApproval or ExternalEnrollment).
 *
 * `options.sameKind` — the filter that says "another batch of this kind": the
 * caller supplies it because the ClickTac batch has an `export_type` and the
 * ministry batch does not.
 * `options.legacyExtra` — how to recognise this batch's rows by file when the
 * batch has no ids (per-model field for the file name).
 * `options.refuse(doc)` — a reason string when a created row must NOT be
 * deleted (a ClickTac row that already became a registration), or null.
 *
 * Returns `{ deleted, restored, names }`.
 */
async function undoBatch({ Model, batch, sameKind, legacyExtra, refuse }) {
  const newer = await EnrollmentImport.findOne({
    ...sameKind,
    branch_id: batch.branch_id,
    academic_year: batch.academic_year,
    created_at: { $gt: batch.created_at },
  }).select('_id file_name created_at').lean();
  if (newer) {
    return {
      error: `אפשר לבטל רק את ההעלאה האחרונה. אחרי הקובץ הזה הועלה "${newer.file_name}" — יש לבטל אותו קודם.`,
      code: 'NOT_LATEST',
      status: 409,
    };
  }

  const createdIds = (batch.created_ids || []).map(String);
  const created = createdIds.length
    ? await Model.find({ _id: { $in: createdIds } })
    : (batch.created > 0 ? await Model.find(legacyCreatedFilter(batch, legacyExtra)) : []);

  const blocked = [];
  for (const doc of created) {
    const why = refuse ? refuse(doc) : null;
    if (why) blocked.push(`${doc.child?.full_name || doc._id} — ${why}`);
  }
  if (blocked.length) {
    return {
      error: `לא ניתן לבטל: ${blocked.length} מהשורות שהקובץ יצר כבר נקלטו למערכת כרישום`,
      code: 'ALREADY_IMPORTED',
      status: 409,
      names: blocked.slice(0, 20),
    };
  }

  const names = created.map(d => d.child?.full_name || '').filter(Boolean);
  if (created.length) {
    await Model.deleteMany({ _id: { $in: created.map(d => d._id) } });
  }

  let restored = 0;
  for (const snap of batch.snapshots || []) {
    const doc = await Model.findById(snap.id);
    if (!doc || !snap.before) continue;
    // Every top-level path, so an array (changes, sources) is put back whole
    // rather than merged with what the batch appended to it.
    for (const [key, value] of Object.entries(snap.before)) doc.set(key, value);
    await doc.save();
    restored += 1;
  }

  await EnrollmentImport.deleteOne({ _id: batch._id });
  return { deleted: created.length, restored, names: names.slice(0, 50) };
}

module.exports = { undoBatch, snapshotCollector, snapshotOf };
