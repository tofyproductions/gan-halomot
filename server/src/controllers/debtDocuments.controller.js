const { ReconcileDecision, Branch, User } = require('../models');
const storage = require('../services/storage.service');
const { dispatchEmail } = require('../services/email.service');
const { normalizeId } = require('../services/tmt.service');
const { normalizeYear, formatAcademicYear } = require('../services/academic-year.service');
const { canAccessBranch } = require('../utils/branch-scope');

/**
 * The papers behind a debt — uploaded, shared, and only reluctantly deleted.
 *
 * The חייבים table already carried a note per family, which is enough for
 * "called, will pay Sunday" and useless for the thing the office actually
 * ends up holding: a signed repayment agreement. That is a legal document. It
 * arrives as a phone photograph or a scan, it has to survive every ClickTac
 * upload, and losing it means losing the only evidence the family agreed to
 * anything.
 *
 * It attaches to the SAME record as the note — ReconcileDecision, keyed by
 * (branch, year, ת"ז) — which is the one thing in this whole comparison that
 * an import cannot overwrite and the archive sweep refuses to delete.
 *
 * Three rules, and each of them exists because of the failure it prevents.
 *
 * WHO. Uploading, sharing and deleting need the same permission as uploading a
 * ClickTac file itself. Reading the חייבים table is a wider circle — a branch
 * manager sees her own gan — and attaching a document to somebody's debt is
 * not the same act as reading that they have one.
 *
 * WHAT THE FAMILY SEES. Nothing, unless somebody says so. Files are private
 * until `visible_to_parent` is turned on one at a time. The office attaches
 * internal things here too, and a document that reaches a family's screen
 * because it went onto the wrong row cannot be recalled.
 *
 * DELETING. Never immediately. The row disappears at once — that is what the
 * person asked for — but the bytes live another week, every system_admin gets
 * the file itself by email the moment it happens, and the purge job takes it
 * only after that. Somebody who deletes the wrong agreement on a Friday and
 * realises on Sunday still has it.
 */

/** A week. Long enough for an email to be read over a weekend. */
const GRACE_DAYS = 7;

const MAX_BYTES = 25 * 1024 * 1024;
const ACCEPTED = /^(image\/(jpe?g|png|webp|heic|heif)|application\/pdf)$/i;

const EXT_OF = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/heic': 'heic', 'image/heif': 'heic', 'application/pdf': 'pdf',
};

/**
 * The (branch, year, ת"ז) this request is about, checked against what the
 * caller may see.
 *
 * The branch comes from the BODY or the query rather than from the document,
 * because a document does not exist yet when it is being uploaded — and it is
 * checked against the caller's real branch scope every time, not once.
 */
async function scopeOf(req) {
  const branchId = req.body?.branch_id || req.query?.branch_id;
  const academicYear = normalizeYear(req.body?.academic_year || req.query?.academic_year || '');
  const idNumber = normalizeId(req.params.idNumber);

  if (!branchId || !academicYear || !idNumber) return { error: 'חסרים פרטי זיהוי' };
  if (!(await canAccessBranch(req, branchId))) return { error: 'אין לך הרשאה לסניף זה', status: 403 };

  return { branchId, academicYear, idNumber };
}

/** What a document looks like on the way out. Never the storage key. */
function documentOut(doc) {
  return {
    id: String(doc._id),
    file_name: doc.file_name || '',
    content_type: doc.content_type || '',
    bytes: doc.bytes || 0,
    visible_to_parent: Boolean(doc.visible_to_parent),
    uploaded_by_name: doc.uploaded_by_name || '',
    uploaded_at: doc.uploaded_at || null,
  };
}

/** The live ones. A soft-deleted document is gone as far as every screen is concerned. */
const liveDocuments = (decision) => (decision?.documents || []).filter(d => !d.deleted_at);

/**
 * POST /api/tmt/decisions/:idNumber/documents
 *
 * Upserts the decision row, because attaching an agreement to a family nobody
 * has written a note about yet is the normal case, not an error.
 */
async function uploadDocument(req, res, next) {
  try {
    if (!storage.isConfigured()) {
      return res.status(503).json({ error: 'אחסון הקבצים אינו מוגדר' });
    }
    const scope = await scopeOf(req);
    if (scope.error) return res.status(scope.status || 400).json({ error: scope.error });

    const file = req.file;
    if (!file) return res.status(400).json({ error: 'לא צורף קובץ' });
    if (!ACCEPTED.test(file.mimetype || '')) {
      return res.status(400).json({ error: 'אפשר לצרף תמונה או PDF בלבד' });
    }
    if (file.size > MAX_BYTES) {
      return res.status(400).json({ error: 'הקובץ גדול מדי (עד 25MB)' });
    }

    const key = storage.makeKey(
      `debt-docs/${scope.branchId}/${scope.academicYear}`,
      EXT_OF[String(file.mimetype).toLowerCase()] || 'pdf',
    );
    await storage.putObject({ key, body: file.buffer, contentType: file.mimetype });

    const entry = {
      key,
      // The office's own name for it, kept for the office's own sake — the
      // storage key deliberately says nothing.
      file_name: String(file.originalname || 'מסמך').slice(0, 200),
      content_type: file.mimetype,
      bytes: file.size,
      // Off. Sharing with the family is a separate, deliberate act.
      visible_to_parent: false,
      uploaded_by: req.user.id,
      uploaded_by_name: req.user.full_name || '',
      uploaded_at: new Date(),
    };

    const decision = await ReconcileDecision.findOneAndUpdate(
      { branch_id: scope.branchId, academic_year: scope.academicYear, id_number: scope.idNumber },
      { $push: { documents: entry } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );

    return res.json({ documents: liveDocuments(decision).map(documentOut) });
  } catch (err) { next(err); }
}

/** GET /api/tmt/decisions/:idNumber/documents?branch_id=&academic_year= */
async function listDocuments(req, res, next) {
  try {
    const scope = await scopeOf(req);
    if (scope.error) return res.status(scope.status || 400).json({ error: scope.error });

    const decision = await ReconcileDecision.findOne({
      branch_id: scope.branchId, academic_year: scope.academicYear, id_number: scope.idNumber,
    }).lean();

    return res.json({ documents: liveDocuments(decision).map(documentOut) });
  } catch (err) { next(err); }
}

/**
 * GET /api/tmt/decisions/:idNumber/documents/:docId/file
 *
 * Returns a signed link that dies in half an hour rather than the bytes
 * themselves. Handed over as JSON, NOT as a redirect: the browser would carry
 * this app's Authorization header on to the storage host, and an S3-compatible
 * bucket refuses a request that arrives with two competing credentials.
 *
 * A soft-deleted document is not served — it exists for a week for one
 * purpose, and that purpose is the copy already attached to the email.
 */
async function openDocument(req, res, next) {
  try {
    const scope = await scopeOf(req);
    if (scope.error) return res.status(scope.status || 400).json({ error: scope.error });

    const decision = await ReconcileDecision.findOne({
      branch_id: scope.branchId, academic_year: scope.academicYear, id_number: scope.idNumber,
    }).lean();

    const doc = (decision?.documents || []).find(d => String(d._id) === String(req.params.docId));
    if (!doc || doc.deleted_at) return res.status(404).json({ error: 'לא נמצא' });

    return res.json({ url: await storage.signedReadUrl(doc.key), file_name: doc.file_name || '' });
  } catch (err) { next(err); }
}

/**
 * PATCH /api/tmt/decisions/:idNumber/documents/:docId
 *
 * The one field a person may change after the fact: whether the family sees
 * it. The file itself is never edited — a signed agreement that can be
 * replaced in place is not evidence of anything.
 */
async function updateDocument(req, res, next) {
  try {
    const scope = await scopeOf(req);
    if (scope.error) return res.status(scope.status || 400).json({ error: scope.error });
    if (typeof req.body?.visible_to_parent !== 'boolean') {
      return res.status(400).json({ error: 'ערך לא תקין' });
    }

    const decision = await ReconcileDecision.findOneAndUpdate(
      {
        branch_id: scope.branchId,
        academic_year: scope.academicYear,
        id_number: scope.idNumber,
        'documents._id': req.params.docId,
      },
      { $set: { 'documents.$.visible_to_parent': req.body.visible_to_parent } },
      { new: true },
    );
    if (!decision) return res.status(404).json({ error: 'לא נמצא' });

    return res.json({ documents: liveDocuments(decision).map(documentOut) });
  } catch (err) { next(err); }
}

/** Every system_admin with a real email address. */
async function adminEmails() {
  const admins = await User.find({ role: 'system_admin', is_active: { $ne: false } })
    .select('email').lean();
  return [...new Set(
    admins.map(a => String(a.email || '').trim().toLowerCase()).filter(e => e.includes('@')),
  )];
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

/**
 * Tell the administrators, with the file itself attached.
 *
 * The attachment is the whole point. A message saying "a document was deleted"
 * leaves the reader with a name and a shrug; a message carrying the document
 * means the deletion is already undone for anybody who cares, whatever happens
 * to the copy in storage a week from now.
 *
 * Never throws. A mail provider having a bad afternoon must not turn a delete
 * into a 500 and leave the screen showing a document the database no longer
 * has — the bytes are still in storage for a week either way.
 */
async function notifyDeletion({ doc, branchName, academicYear, idNumber, byName, keyBuffer }) {
  try {
    const to = await adminEmails();
    if (!to.length) return;

    const attachment = keyBuffer
      ? [{
        filename: doc.file_name || 'document',
        contentBase64: keyBuffer.toString('base64'),
        contentType: doc.content_type || 'application/octet-stream',
      }]
      : [];

    await dispatchEmail({
      to,
      subject: `נמחק מסמך חוב — ${branchName} · ת"ז ${idNumber}`,
      html: `
        <div dir="rtl" style="font-family:Arial,sans-serif;font-size:15px">
          <p><b>${esc(byName || 'משתמש')}</b> מחק/ה מסמך מרשימת החייבים.</p>
          <table cellpadding="6" style="border-collapse:collapse;font-size:14px">
            <tr><td>סניף</td><td><b>${esc(branchName)}</b></td></tr>
            <tr><td>שנה</td><td>${esc(formatAcademicYear(academicYear))}</td></tr>
            <tr><td>ת"ז הילד/ה</td><td>${esc(idNumber)}</td></tr>
            <tr><td>שם הקובץ</td><td>${esc(doc.file_name)}</td></tr>
            <tr><td>הועלה על ידי</td><td>${esc(doc.uploaded_by_name)}</td></tr>
          </table>
          <p>הקובץ מצורף להודעה הזו${attachment.length ? '' : ' — ולא הצלחנו לצרף אותו'}.
             הוא יישמר במערכת עוד ${GRACE_DAYS} ימים ואז יימחק לצמיתות.
             אם המחיקה היא טעות — יש לשמור את הקובץ המצורף ולהעלות אותו מחדש.</p>
        </div>`,
      fileAttachments: attachment,
    });
  } catch (err) {
    console.error('[debt-docs] deletion notice failed:', err.message);
  }
}

/**
 * DELETE /api/tmt/decisions/:idNumber/documents/:docId
 *
 * Marks it deleted and schedules the bytes for a week later. The object is
 * fetched first so it can be attached to the notice — and if that fetch fails
 * the deletion still goes through, with the email saying so, because a
 * storage hiccup must not leave somebody unable to remove a file they
 * uploaded by mistake.
 */
async function deleteDocument(req, res, next) {
  try {
    const scope = await scopeOf(req);
    if (scope.error) return res.status(scope.status || 400).json({ error: scope.error });

    const decision = await ReconcileDecision.findOne({
      branch_id: scope.branchId, academic_year: scope.academicYear, id_number: scope.idNumber,
    });
    if (!decision) return res.status(404).json({ error: 'לא נמצא' });

    const doc = decision.documents.id(req.params.docId);
    if (!doc || doc.deleted_at) return res.status(404).json({ error: 'לא נמצא' });

    const now = new Date();
    doc.deleted_at = now;
    doc.deleted_by = req.user.id;
    doc.deleted_by_name = req.user.full_name || '';
    doc.purge_after = new Date(now.getTime() + GRACE_DAYS * 24 * 60 * 60 * 1000);
    // A deleted document is nobody's to look at, least of all the family's.
    doc.visible_to_parent = false;
    await decision.save();

    const branch = await Branch.findById(scope.branchId).select('name').lean();

    // Read the bytes for the notice. Allowed to fail — see the doc comment.
    let buffer = null;
    try {
      const url = await storage.signedReadUrl(doc.key, 120);
      const res2 = await fetch(url);
      if (res2.ok) buffer = Buffer.from(await res2.arrayBuffer());
    } catch (err) {
      console.error('[debt-docs] could not read the file for the notice:', err.message);
    }

    // Not awaited: the person pressing delete should not wait on a mail
    // provider, and the notice cannot change the outcome.
    notifyDeletion({
      doc,
      branchName: branch?.name || '',
      academicYear: scope.academicYear,
      idNumber: scope.idNumber,
      byName: req.user.full_name,
      keyBuffer: buffer,
    });

    return res.json({
      ok: true,
      grace_days: GRACE_DAYS,
      documents: liveDocuments(decision).map(documentOut),
    });
  } catch (err) { next(err); }
}

module.exports = {
  uploadDocument, listDocuments, openDocument, updateDocument, deleteDocument,
  documentOut, liveDocuments, GRACE_DAYS,
};
