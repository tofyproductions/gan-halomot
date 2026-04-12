const { Registration, Child, Document } = require('../models');
const { generateContractHTML, generateContractPDF } = require('../services/contract-pdf.service');
const fileStorage = require('../services/file-storage.service');
const { sendAgreementEmail } = require('../services/email.service');
const { getAcademicYearStr, getAcademicYears } = require('../services/academic-year.service');

async function getRegistrationForm(req, res, next) {
  try {
    const { token } = req.params;

    const registration = await Registration.findOne({ access_token: token })
      .populate('classroom_id', 'name').lean();

    if (!registration) {
      return res.status(404).json({ error: 'Registration not found or link expired' });
    }

    if (registration.token_expires_at && new Date(registration.token_expires_at) < new Date()) {
      return res.status(410).json({ error: 'Registration link has expired' });
    }

    registration.classroom = registration.classroom_id?.name || null;
    const contractHTML = generateContractHTML(registration);

    const configuration = registration.configuration || {};

    const documents = await Document.find({ registration_id: registration._id })
      .select('doc_type file_name uploaded_at').lean();

    res.json({
      registration: {
        id: registration._id,
        unique_id: registration.unique_id,
        child_name: registration.child_name,
        child_birth_date: registration.child_birth_date,
        parent_name: registration.parent_name,
        parent_phone: registration.parent_phone,
        parent_email: registration.parent_email,
        classroom: registration.classroom,
        monthly_fee: registration.monthly_fee,
        registration_fee: registration.registration_fee,
        start_date: registration.start_date,
        end_date: registration.end_date,
        status: registration.status,
        agreement_signed: registration.agreement_signed,
        card_completed: registration.card_completed,
        configuration,
      },
      contractHTML,
      documents,
    });
  } catch (error) {
    next(error);
  }
}

async function submitSignature(req, res, next) {
  try {
    const { token } = req.params;
    const { signature, parentEmail, phone, medical, registrationCard } = req.body;

    if (!signature) {
      return res.status(400).json({ error: 'Signature is required' });
    }

    const registration = await Registration.findOne({ access_token: token })
      .populate('classroom_id', 'name');

    if (!registration) {
      return res.status(404).json({ error: 'Registration not found or link expired' });
    }

    registration.signature_data = signature;
    registration.agreement_signed = true;
    registration.status = 'contract_signed';

    if (parentEmail) registration.parent_email = parentEmail;
    if (phone) registration.parent_phone = phone;

    const config = registration.configuration || {};
    if (medical) config.medical_alerts = medical;
    if (registrationCard) config.registration_card = registrationCard;
    registration.configuration = config;

    await registration.save();

    const pdfData = { ...registration.toObject(), classroom: registration.classroom_id?.name || null, signature_data: signature };
    const pdfBuffer = await generateContractPDF(pdfData);

    const key = `contracts/${registration.unique_id}_signed_${Date.now()}.pdf`;
    await fileStorage.upload(pdfBuffer, key, 'application/pdf');

    registration.contract_pdf_path = key;
    await registration.save();

    try {
      await sendAgreementEmail({
        childName: registration.child_name,
        parentName: registration.parent_name,
        parentEmail: parentEmail || registration.parent_email,
        contractPdfBuffer: pdfBuffer,
      });
    } catch (emailErr) {
      console.error('Failed to send agreement email:', emailErr.message);
    }

    res.json({ message: 'Contract signed successfully', status: 'contract_signed' });
  } catch (error) {
    next(error);
  }
}

async function uploadDocument(req, res, next) {
  try {
    const { token } = req.params;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const registration = await Registration.findOne({ access_token: token });
    if (!registration) {
      return res.status(404).json({ error: 'Registration not found or link expired' });
    }

    const docType = req.body.doc_type || 'general';
    const key = `documents/${registration.unique_id}/${docType}_${Date.now()}_${file.originalname}`;
    await fileStorage.upload(file.buffer, key, file.mimetype);

    const document = await Document.create({
      registration_id: registration._id,
      doc_type: docType,
      file_name: file.originalname,
      file_path: key,
      mime_type: file.mimetype,
      file_size_bytes: file.size,
    });

    const uploadedDocs = await Document.find({ registration_id: registration._id }).select('doc_type');
    const docTypes = uploadedDocs.map(d => d.doc_type);
    const hasIdCopy = docTypes.includes('id_copy');
    const hasPaymentProof = docTypes.includes('payment_proof');
    const bothDocsUploaded = hasIdCopy && hasPaymentProof;

    if (bothDocsUploaded) {
      registration.card_completed = true;
      if (registration.status === 'contract_signed' || registration.status === 'docs_uploaded') {
        registration.status = 'docs_uploaded';
      }
    }

    const isFullyComplete = registration.agreement_signed && bothDocsUploaded;
    if (isFullyComplete) {
      registration.status = 'completed';
    }

    await registration.save();

    if (isFullyComplete) {
      const academicYear = getAcademicYearStr(registration.start_date)
        || getAcademicYears().current.range;

      const existingChild = await Child.findOne({ registration_id: registration._id });
      if (!existingChild) {
        const config = registration.configuration || {};
        await Child.create({
          registration_id: registration._id,
          child_name: registration.child_name,
          birth_date: registration.child_birth_date,
          classroom_id: registration.classroom_id,
          parent_name: registration.parent_name,
          phone: registration.parent_phone,
          email: registration.parent_email,
          medical_alerts: config.medical_alerts || null,
          academic_year: academicYear,
          is_active: true,
        });
      }
    }

    res.status(201).json({
      document: { ...document.toObject(), id: document._id },
      card_completed: bothDocsUploaded,
      registration_complete: isFullyComplete,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = { getRegistrationForm, submitSignature, uploadDocument };
