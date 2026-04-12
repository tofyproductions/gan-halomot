const db = require('../config/database');
const { generateContractHTML, generateContractPDF } = require('../services/contract-pdf.service');
const fileStorage = require('../services/file-storage.service');
const { sendAgreementEmail } = require('../services/email.service');
const { getAcademicYearStr, getAcademicYears } = require('../services/academic-year.service');

/**
 * GET /api/public/register/:token
 * Find registration by access_token. Return registration data + contract HTML.
 * No JWT auth required - uses access_token for authorization.
 */
async function getRegistrationForm(req, res, next) {
  try {
    const { token } = req.params;

    const registration = await db('registrations')
      .select('registrations.*', 'classrooms.name as classroom')
      .leftJoin('classrooms', 'registrations.classroom_id', 'classrooms.id')
      .where('registrations.access_token', token)
      .first();

    if (!registration) {
      return res.status(404).json({ error: 'Registration not found or link expired' });
    }

    // Check token expiry
    if (registration.token_expires_at && new Date(registration.token_expires_at) < new Date()) {
      return res.status(410).json({ error: 'Registration link has expired' });
    }

    // Generate contract HTML for preview
    const contractHTML = generateContractHTML(registration);

    // Parse configuration
    let configuration = {};
    if (typeof registration.configuration === 'string') {
      try { configuration = JSON.parse(registration.configuration); } catch { /* empty */ }
    } else {
      configuration = registration.configuration || {};
    }

    // Get already uploaded documents
    const documents = await db('documents')
      .select('id', 'doc_type', 'file_name', 'uploaded_at')
      .where({ registration_id: registration.id });

    res.json({
      registration: {
        id: registration.id,
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

/**
 * POST /api/public/register/:token/sign
 * Submit contract signature. Update registration. Generate PDF. Send email.
 */
async function submitSignature(req, res, next) {
  try {
    const { token } = req.params;
    const { signature, parentEmail, phone, medical, registrationCard } = req.body;

    if (!signature) {
      return res.status(400).json({ error: 'Signature is required' });
    }

    const registration = await db('registrations')
      .select('registrations.*', 'classrooms.name as classroom')
      .leftJoin('classrooms', 'registrations.classroom_id', 'classrooms.id')
      .where('registrations.access_token', token)
      .first();

    if (!registration) {
      return res.status(404).json({ error: 'Registration not found or link expired' });
    }

    // Update registration with signature and contact info
    const updateData = {
      signature_data: signature,
      agreement_signed: true,
      status: 'contract_signed',
      updated_at: new Date(),
    };

    if (parentEmail) updateData.parent_email = parentEmail;
    if (phone) updateData.parent_phone = phone;

    // Store additional data in configuration
    let config = {};
    if (typeof registration.configuration === 'string') {
      try { config = JSON.parse(registration.configuration); } catch { /* empty */ }
    } else {
      config = registration.configuration || {};
    }

    if (medical) config.medical_alerts = medical;
    if (registrationCard) config.registration_card = registrationCard;
    updateData.configuration = JSON.stringify(config);

    await db('registrations').where({ id: registration.id }).update(updateData);

    // Generate contract PDF with signature
    const pdfData = { ...registration, signature_data: signature };
    const pdfBuffer = await generateContractPDF(pdfData);

    // Upload PDF to R2
    const key = `contracts/${registration.unique_id}_signed_${Date.now()}.pdf`;
    await fileStorage.upload(pdfBuffer, key, 'application/pdf');

    // Update contract path
    await db('registrations').where({ id: registration.id }).update({
      contract_pdf_path: key,
    });

    // Send email with signed contract
    try {
      await sendAgreementEmail({
        childName: registration.child_name,
        parentName: registration.parent_name,
        parentEmail: parentEmail || registration.parent_email,
        contractPdfBuffer: pdfBuffer,
      });
    } catch (emailErr) {
      console.error('Failed to send agreement email:', emailErr.message);
      // Do not fail the request if email fails
    }

    res.json({
      message: 'Contract signed successfully',
      status: 'contract_signed',
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/public/register/:token/upload
 * Handle file uploads from parent. Save to R2. Insert into documents.
 * If both docs uploaded, set card_completed=true.
 * If fully complete (signed + card), set status=completed and create child record.
 */
async function uploadDocument(req, res, next) {
  try {
    const { token } = req.params;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const registration = await db('registrations')
      .where({ access_token: token })
      .first();

    if (!registration) {
      return res.status(404).json({ error: 'Registration not found or link expired' });
    }

    const docType = req.body.doc_type || 'general';

    // Upload to R2
    const key = `documents/${registration.unique_id}/${docType}_${Date.now()}_${file.originalname}`;
    await fileStorage.upload(file.buffer, key, file.mimetype);

    // Insert document record
    const [document] = await db('documents')
      .insert({
        registration_id: registration.id,
        doc_type: docType,
        file_name: file.originalname,
        file_path: key,
        mime_type: file.mimetype,
        file_size_bytes: file.size,
      })
      .returning('*');

    // Check if both required docs are now uploaded (id_copy + payment_proof)
    const uploadedDocs = await db('documents')
      .where({ registration_id: registration.id })
      .select('doc_type');

    const docTypes = uploadedDocs.map(d => d.doc_type);
    const hasIdCopy = docTypes.includes('id_copy');
    const hasPaymentProof = docTypes.includes('payment_proof');
    const bothDocsUploaded = hasIdCopy && hasPaymentProof;

    const updateData = { updated_at: new Date() };

    if (bothDocsUploaded) {
      updateData.card_completed = true;

      if (registration.status === 'contract_signed' || registration.status === 'docs_uploaded') {
        updateData.status = 'docs_uploaded';
      }
    }

    // Check if fully complete: signed + both docs
    const isFullyComplete = registration.agreement_signed && bothDocsUploaded;

    if (isFullyComplete) {
      updateData.status = 'completed';
    }

    await db('registrations').where({ id: registration.id }).update(updateData);

    // If fully complete, create child record
    if (isFullyComplete) {
      const academicYear = getAcademicYearStr(registration.start_date)
        || getAcademicYears().current.range;

      const existingChild = await db('children')
        .where({ registration_id: registration.id })
        .first();

      if (!existingChild) {
        // Parse config for medical alerts
        let config = {};
        if (typeof registration.configuration === 'string') {
          try { config = JSON.parse(registration.configuration); } catch { /* empty */ }
        } else {
          config = registration.configuration || {};
        }

        await db('children').insert({
          registration_id: registration.id,
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
      document,
      card_completed: bothDocsUploaded,
      registration_complete: isFullyComplete,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = { getRegistrationForm, submitSignature, uploadDocument };
