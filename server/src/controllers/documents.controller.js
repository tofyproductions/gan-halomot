const { Registration, Child, Document } = require('../models');
const fileStorage = require('../services/file-storage.service');

async function getByRegistration(req, res, next) {
  try {
    const { registrationId } = req.params;
    const registration = await Registration.findById(registrationId);
    if (!registration) {
      return res.status(404).json({ error: 'Registration not found' });
    }

    const documents = await Document.find({ registration_id: registrationId })
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

    const docType = req.body.doc_type || 'general';
    const key = `documents/${registration.unique_id}/${docType}_${Date.now()}_${file.originalname}`;
    await fileStorage.upload(file.buffer, key, file.mimetype);

    const child = await Child.findOne({ registration_id: registrationId, is_active: true });

    const document = await Document.create({
      registration_id: registrationId,
      child_id: child?._id || null,
      doc_type: docType,
      file_name: file.originalname,
      file_path: key,
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

    const url = await fileStorage.getPresignedUrl(document.file_path, 600);
    res.redirect(url);
  } catch (error) {
    next(error);
  }
}

module.exports = { getByRegistration, upload, download };
