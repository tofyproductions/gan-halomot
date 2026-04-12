const db = require('../config/database');
const fileStorage = require('../services/file-storage.service');

/**
 * GET /api/documents/:registrationId
 * Get all documents for a registration
 */
async function getByRegistration(req, res, next) {
  try {
    const { registrationId } = req.params;

    const registration = await db('registrations').where({ id: registrationId }).first();
    if (!registration) {
      return res.status(404).json({ error: 'Registration not found' });
    }

    const documents = await db('documents')
      .where({ registration_id: registrationId })
      .orderBy('uploaded_at', 'desc');

    res.json({ documents });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/documents/:registrationId/upload
 * Upload a document to R2 and insert into documents table
 * Expects req.file from multer (memoryStorage)
 */
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

    const registration = await db('registrations').where({ id: registrationId }).first();
    if (!registration) {
      return res.status(404).json({ error: 'Registration not found' });
    }

    const docType = req.body.doc_type || 'general';

    // Upload to R2
    const key = `documents/${registration.unique_id}/${docType}_${Date.now()}_${file.originalname}`;
    await fileStorage.upload(file.buffer, key, file.mimetype);

    // Get linked child
    const child = await db('children')
      .where({ registration_id: registrationId, is_active: true })
      .first();

    // Insert into documents table
    const [document] = await db('documents')
      .insert({
        registration_id: parseInt(registrationId),
        child_id: child ? child.id : null,
        doc_type: docType,
        file_name: file.originalname,
        file_path: key,
        mime_type: file.mimetype,
        file_size_bytes: file.size,
      })
      .returning('*');

    res.status(201).json({ document });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/documents/download/:id
 * Get presigned URL from R2 and redirect
 */
async function download(req, res, next) {
  try {
    const { id } = req.params;

    const document = await db('documents').where({ id }).first();
    if (!document) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const url = await fileStorage.getPresignedUrl(document.file_path, 600);
    res.redirect(url);
  } catch (error) {
    next(error);
  }
}

module.exports = { getByRegistration, upload, download };
