const { Registration, Child, Document } = require('../models');
const { canAccessRegistration } = require('../utils/branch-scope');
const { isRead } = require('../utils/viewer');
const { ADMIN_VIEWER } = require('../constants/roles');

/**
 * "Is this registration outside what the caller may work on?"
 *
 * canAccessRegistration answers against the caller's WRITE scope on a write,
 * which is right for a branch manager — another gan's registration must look
 * like it does not exist, or the 404 itself tells her it does.
 *
 * The admin_viewer is the exception, and she is the reason this wrapper exists.
 * Her read scope is every branch, so 404 on an upload would be a lie about a
 * registration she can open and read on screen; worse, it preempts the guard
 * that is supposed to answer. A multipart upload from a viewer is refused
 * 403 VIEWER_NO_UPLOAD with NO proposal filed — deliberately, because a
 * multipart body cannot be replayed later and the proposal would be one the
 * office could never apply. Refusing her here instead returns the wrong code
 * for the wrong reason. She is let through to the write, where the guard
 * refuses her properly; a viewer uploading to a gan she DOES manage lands, as
 * it should. viewer-e2e 13h is this case.
 */
async function outOfScope(req, registrationId) {
  /**
   * `actual_role`, not `role`. middleware/auth.js serves a viewer's WRITE as a
   * branch_manager (the fallback that lets the write reach the code that will
   * refuse or propose it), so `req.user.role` says branch_manager here and
   * asking it would miss exactly the caller this exists for. `actual_role` is
   * set on both the read swap and the write fallback for this reason.
   */
  if (req.user?.actual_role === ADMIN_VIEWER && !isRead(req)) return false;
  return !(await canAccessRegistration(req, registrationId));
}

// The file is base64 inside a Mongo document, so it counts against the 16MB
// document cap; 8MB raw (~11MB encoded) leaves comfortable room.
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

async function getByRegistration(req, res, next) {
  try {
    const { registrationId } = req.params;
    const registration = await Registration.findById(registrationId);
    if (!registration) {
      return res.status(404).json({ error: 'Registration not found' });
    }
    if (await outOfScope(req, registrationId)) {
      return res.status(404).json({ error: 'Registration not found' });
    }

    const documents = await Document.find({ registration_id: registrationId })
      .select('-file_data')          // listings must not carry the file bytes
      .sort({ uploaded_at: -1 }).lean();

    res.json({ documents: documents.map(d => ({ ...d, id: d._id })) });
  } catch (error) {
    next(error);
  }
}

async function upload(req, res, next) {
  try {
    const registrationId = req.params.registrationId || req.body.registration_id;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    if (!registrationId) {
      return res.status(400).json({ error: 'registration_id is required' });
    }

    const registration = await Registration.findById(registrationId);
    if (!registration) {
      return res.status(404).json({ error: 'Registration not found' });
    }
    if (await outOfScope(req, registrationId)) {
      return res.status(404).json({ error: 'Registration not found' });
    }

    const docType = req.body.doc_type || 'general';
    if (file.size > MAX_UPLOAD_BYTES) {
      return res.status(413).json({ error: `הקובץ גדול מדי (מקסימום ${MAX_UPLOAD_BYTES / 1024 / 1024}MB)` });
    }

    const child = await Child.findOne({ registration_id: registrationId, is_active: true });

    const document = await Document.create({
      registration_id: registrationId,
      child_id: child?._id || null,
      doc_type: docType,
      file_name: file.originalname,
      file_data: file.buffer.toString('base64'),
      mime_type: file.mimetype,
      file_size_bytes: file.size,
    });

    res.status(201).json({ document: { ...document.toObject(), id: document._id } });
  } catch (error) {
    next(error);
  }
}

async function download(req, res, next) {
  try {
    const { id } = req.params;
    const document = await Document.findById(id);
    if (!document) {
      return res.status(404).json({ error: 'Document not found' });
    }
    if (await outOfScope(req, document.registration_id)) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // Externally-hosted docs (Google Drive files migrated from the old system)
    // redirect to their URL; everything we hold ourselves is served from Mongo.
    if (document.external_url) {
      return res.redirect(document.external_url);
    }
    if (document.file_data) {
      const buffer = Buffer.from(document.file_data, 'base64');
      res.setHeader('Content-Type', document.mime_type || 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(document.file_name || 'document')}"`);
      return res.send(buffer);
    }
    // A legacy row pointing at object storage that never actually received the
    // bytes. Say so plainly instead of failing as if the file were merely
    // unreachable.
    return res.status(404).json({
      error: document.file_path
        ? 'הקובץ לא נשמר בפועל — יש להעלות אותו מחדש'
        : 'Document has no file',
    });
  } catch (error) {
    next(error);
  }
}

module.exports = { getByRegistration, upload, download };
