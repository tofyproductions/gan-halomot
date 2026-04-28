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
        parent_id_number: registration.parent_id_number,
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
      contractHtml: contractHTML,
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

    // Best-effort: generate PDF, upload to R2, email parent. Do not fail the
    // signature request if any of these throw (e.g. R2 not configured).
    let pdfBuffer = null;
    try {
      const pdfData = { ...registration.toObject(), classroom: registration.classroom_id?.name || null, signature_data: signature };
      pdfBuffer = await generateContractPDF(pdfData);
    } catch (pdfErr) {
      console.error('Failed to generate contract PDF:', pdfErr.message);
    }

    if (pdfBuffer) {
      try {
        const key = `contracts/${registration.unique_id}_signed_${Date.now()}.pdf`;
        await fileStorage.upload(pdfBuffer, key, 'application/pdf');
        registration.contract_pdf_path = key;
        await registration.save();
      } catch (uploadErr) {
        console.error('Failed to upload signed contract:', uploadErr.message);
      }

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
    }

    res.json({ message: 'Contract signed successfully', status: 'contract_signed' });
  } catch (error) {
    next(error);
  }
}

async function uploadDocument(req, res, next) {
  try {
    const { token } = req.params;

    const registration = await Registration.findOne({ access_token: token });
    if (!registration) {
      return res.status(404).json({ error: 'Registration not found or link expired' });
    }

    // Persist registration-card form fields onto registration.configuration.
    // The wizard sends them as multipart form fields alongside the files.
    const CARD_FIELDS = [
      'childFullName', 'childBirthDate', 'childIdNumber',
      'parent1Name', 'parent1Id', 'parent1Phone', 'parent1Email',
      'parent2Name', 'parent2Id', 'parent2Phone', 'parent2Email',
      'address', 'medicalInfo', 'allergies',
      'emergencyContact', 'emergencyPhone', 'notes',
    ];
    const card = {};
    for (const f of CARD_FIELDS) {
      if (req.body[f] !== undefined) card[f] = req.body[f];
    }
    const config = registration.configuration || {};
    if (Object.keys(card).length > 0) {
      config.registration_card = { ...(config.registration_card || {}), ...card };
    }
    if (card.medicalInfo) config.medical_alerts = card.medicalInfo;
    registration.configuration = config;

    // Sync card data into the Registration's primary fields so the manager
    // sees the parent's submitted info on the customer card, not just the
    // original wizard data.
    if (card.childFullName?.trim()) registration.child_name = card.childFullName.trim();
    if (card.childBirthDate) registration.child_birth_date = card.childBirthDate;
    if (card.parent1Name?.trim()) registration.parent_name = card.parent1Name.trim();
    if (card.parent1Id?.trim()) registration.parent_id_number = card.parent1Id.trim();
    if (card.parent1Phone?.trim()) registration.parent_phone = card.parent1Phone.trim();
    if (card.parent1Email?.trim()) registration.parent_email = card.parent1Email.trim();

    // Collect uploaded files. multer.fields() returns req.files[fieldName] = [files].
    const filesByField = req.files || {};
    const filesToSave = [];
    if (filesByField.parentIdFile?.[0]) {
      filesToSave.push({ file: filesByField.parentIdFile[0], doc_type: 'id_copy' });
    }
    if (filesByField.paymentProof?.[0]) {
      filesToSave.push({ file: filesByField.paymentProof[0], doc_type: 'payment_proof' });
    }
    if (filesByField.file?.[0]) {
      const docType = req.body.doc_type || 'general';
      filesToSave.push({ file: filesByField.file[0], doc_type: docType });
    }

    const savedDocs = [];
    for (const { file, doc_type } of filesToSave) {
      const key = `documents/${registration.unique_id}/${doc_type}_${Date.now()}_${file.originalname}`;
      try {
        await fileStorage.upload(file.buffer, key, file.mimetype);
        const doc = await Document.create({
          registration_id: registration._id,
          doc_type,
          file_name: file.originalname,
          file_path: key,
          mime_type: file.mimetype,
          file_size_bytes: file.size,
        });
        savedDocs.push({ ...doc.toObject(), id: doc._id });
      } catch (uploadErr) {
        console.error(`Failed to upload ${doc_type}:`, uploadErr.message);
      }
    }

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
    } else if (Object.keys(card).length > 0) {
      // Even without files, accepting card data advances status if signed.
      if (registration.agreement_signed && registration.status === 'contract_signed') {
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

      const childPayload = {
        child_name: registration.child_name,
        child_id_number: card.childIdNumber || null,
        birth_date: registration.child_birth_date,
        classroom_id: registration.classroom_id,
        parent_name: registration.parent_name,
        parent_id_number: registration.parent_id_number || card.parent1Id || null,
        phone: registration.parent_phone,
        email: registration.parent_email,
        parent2_name: card.parent2Name || null,
        parent2_id_number: card.parent2Id || null,
        parent2_phone: card.parent2Phone || null,
        parent2_email: card.parent2Email || null,
        address: card.address || null,
        medical_alerts: card.medicalInfo || config.medical_alerts || null,
        allergies: card.allergies || null,
        emergency_contact: card.emergencyContact || null,
        emergency_phone: card.emergencyPhone || null,
        notes: card.notes || null,
        academic_year: academicYear,
        is_active: true,
      };

      const existingChild = await Child.findOne({ registration_id: registration._id });
      if (!existingChild) {
        await Child.create({ registration_id: registration._id, ...childPayload });
      } else {
        Object.assign(existingChild, childPayload);
        await existingChild.save();
      }
    }

    res.status(201).json({
      documents: savedDocs,
      card_completed: bothDocsUploaded,
      registration_complete: isFullyComplete,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = { getRegistrationForm, submitSignature, uploadDocument };
