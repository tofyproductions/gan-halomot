const { Registration, Child, Document, GanEvent, Branch } = require('../models');
const { generateContractHTML, generateContractPDF } = require('../services/contract-pdf.service');
const { sendAgreementEmail } = require('../services/email.service');
const { academicYearOf, getAcademicYears } = require('../services/academic-year.service');

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
    // Don't regress a registration that already advanced past signing — e.g. a
    // completed contract re-signing from a "signature reminder". Only move
    // forward from the initial link_generated state.
    const statusRank = { link_generated: 0, contract_signed: 1, docs_uploaded: 2, completed: 3 };
    if ((statusRank[registration.status] ?? 0) < statusRank.contract_signed) {
      registration.status = 'contract_signed';
    }

    if (parentEmail) registration.parent_email = parentEmail;
    if (phone) registration.parent_phone = phone;

    const config = registration.configuration || {};
    if (medical) config.medical_alerts = medical;
    if (registrationCard) config.registration_card = registrationCard;
    registration.configuration = config;

    await registration.save();

    // The real PDF is rendered in the parent's browser (html2pdf) and posted
    // back to /contract-pdf — which stores it in R2 and emails it. The server
    // has no HTML→PDF engine (no Chromium), so we return the authoritative
    // signed-contract HTML here for that client-side render.
    const pdfData = {
      ...registration.toObject(),
      classroom: registration.classroom_id?.name || null,
      signature_data: signature,
    };
    const contractHtml = generateContractHTML(pdfData);

    res.json({ message: 'Contract signed successfully', status: 'contract_signed', contractHtml });
  } catch (error) {
    next(error);
  }
}

// Receives the REAL signed-contract PDF rendered by the parent's browser
// (html2pdf), stores it in R2, and emails it. Separating this from /sign keeps
// PDF generation on the client (the server has no Chromium) while the signed
// HTML stays the server's single source of truth.
async function storeSignedContract(req, res, next) {
  try {
    const { token } = req.params;
    const { pdf } = req.body; // base64 (optionally a data: URI) of the real PDF
    if (!pdf) return res.status(400).json({ error: 'pdf is required' });

    const registration = await Registration.findOne({ access_token: token })
      .populate('classroom_id', 'name');
    if (!registration) {
      return res.status(404).json({ error: 'Registration not found or link expired' });
    }

    const base64 = String(pdf).replace(/^data:application\/pdf(;base64)?,/, '');
    const pdfBuffer = Buffer.from(base64, 'base64');
    // Guard: a real PDF begins with "%PDF". Refuse anything else (e.g. HTML).
    if (pdfBuffer.length < 5 || pdfBuffer.slice(0, 4).toString('latin1') !== '%PDF') {
      return res.status(400).json({ error: 'Invalid PDF content' });
    }

    // The signed PDF is kept as a Contract record — base64 in Mongo, the same
    // place employment contracts and employee documents have always lived.
    // It used to be pushed to object storage that was never configured, so
    // every parent signature since launch was written into a void and only the
    // emailed copy survived.
    try {
      const { Contract } = require('../models');
      const contract = await Contract.create({
        registration_id: registration._id,
        type: 'enrollment',
        doc_type: 'enrollment_contract',
        file_name: `contract_${registration.unique_id}_signed.pdf`,
        file_data: pdfBuffer.toString('base64'),
        file_mimetype: 'application/pdf',
        status: 'signed',
        signed_at: new Date(),
      });
      registration.contract_pdf_path = `/api/contracts/doc/${contract._id}/file`;
      await registration.save();
    } catch (uploadErr) {
      console.error('Failed to store signed contract:', uploadErr.message);
    }

    try {
      await sendAgreementEmail({
        childName: registration.child_name,
        parentName: registration.parent_name,
        parentEmail: registration.parent_email,
        contractPdfBuffer: pdfBuffer,
      });
    } catch (emailErr) {
      console.error('Failed to send agreement email:', emailErr.message);
    }

    res.json({ ok: true });
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
      try {
        if (file.size > 8 * 1024 * 1024) throw new Error('file too large (max 8MB)');
        const doc = await Document.create({
          registration_id: registration._id,
          doc_type,
          file_name: file.originalname,
          file_data: file.buffer.toString('base64'),
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

    const cardSubmitted = Object.keys(card).length > 0;
    if (bothDocsUploaded || cardSubmitted) {
      registration.card_completed = true;
    }

    // Completion rule: parent signed digitally + submitted the registration
    // card. Document uploads (id_copy / payment_proof) are optional — the
    // manager can collect them later from the documents dialog.
    const isFullyComplete = registration.agreement_signed && (bothDocsUploaded || cardSubmitted);
    if (isFullyComplete) {
      registration.status = 'completed';
    } else if (bothDocsUploaded || cardSubmitted) {
      registration.status = 'docs_uploaded';
    }

    await registration.save();

    if (isFullyComplete) {
      const academicYear = academicYearOf(registration)
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

// ===================== Gan events (parent-facing) =====================
// Parents have no login. They reach an event via its access_token link, see the
// bring-list with remaining counts, and claim items first-come-first-served.
// Other parents' identities are NOT exposed — only counts + the visitor's own
// picks. Identity across visits: a browser-minted claimant_id (same device) or
// a matching phone number (any device).

const digits = (s) => String(s || '').replace(/\D/g, '');

/** Public-safe view: event meta, grouped items with remaining counts, my picks. */
function publicEventView(ev, { claimant_id, phone } = {}) {
  const cid = claimant_id || null;
  const ph = digits(phone);
  const isMine = (it) =>
    !!it.claimed_by_id &&
    ((cid && it.claimed_by_id === cid) || (ph && digits(it.parent_phone) === ph));

  const order = [];
  const byName = new Map();
  for (const it of ev.items) {
    if (!byName.has(it.name)) { byName.set(it.name, { name: it.name, total: 0, remaining: 0 }); order.push(it.name); }
    const g = byName.get(it.name);
    g.total += 1;
    if (!it.claimed_by_id) g.remaining += 1;
  }
  const items = order.map((n) => byName.get(n));
  const mine = ev.items.filter(isMine).map((it) => ({ slot_id: String(it._id), name: it.name }));

  return {
    event: {
      name: ev.name,
      event_date: ev.event_date,
      event_time: ev.event_time,
      description: ev.description,
      status: ev.status,
      branch_name: ev.branch_id?.name || '',
    },
    items,
    mine,
    allow_multiple: !!ev.allow_multiple_per_parent,
    closed: ev.status !== 'published',
  };
}

// Does this claimant already hold a slot in the event (by device id or phone)?
function alreadyClaimed(ev, claimant_id, phone) {
  const ph = digits(phone);
  return ev.items.some((it) => it.claimed_by_id && (
    (claimant_id && it.claimed_by_id === claimant_id) || (ph && digits(it.parent_phone) === ph)
  ));
}

async function getEvent(req, res, next) {
  try {
    const ev = await GanEvent.findOne({ access_token: req.params.token }).populate('branch_id', 'name');
    if (!ev) return res.status(404).json({ error: 'האירוע לא נמצא או שהקישור אינו תקין' });
    res.json(publicEventView(ev, { claimant_id: req.query.claimant_id, phone: req.query.phone }));
  } catch (error) { next(error); }
}

async function claimItem(req, res, next) {
  try {
    const { token } = req.params;
    const { claimant_id, parent_name, parent_phone, item_name } = req.body || {};
    if (!claimant_id) return res.status(400).json({ error: 'מזהה משתמש חסר' });
    if (!parent_name || !String(parent_name).trim()) return res.status(400).json({ error: 'יש להזין שם' });
    if (!item_name) return res.status(400).json({ error: 'לא נבחר פריט' });

    // One-item-per-parent limit (unless the manager allowed multiple). Checked
    // before the atomic grab; the tiny race is benign (worst case one extra pick).
    const existing = await GanEvent.findOne({ access_token: token }).populate('branch_id', 'name');
    if (!existing) return res.status(404).json({ error: 'האירוע לא נמצא' });
    if (!existing.allow_multiple_per_parent && alreadyClaimed(existing, claimant_id, parent_phone)) {
      return res.status(409).json({ error: 'אפשר לבחור פריט אחד בלבד', view: publicEventView(existing, { claimant_id, phone: parent_phone }) });
    }

    // Atomic first-free-slot grab: the positional `$` targets the first slot of
    // this name whose claimed_by_id is null. Two parents racing the last slot →
    // exactly one update matches; the other gets null and a 409.
    const updated = await GanEvent.findOneAndUpdate(
      {
        access_token: token,
        status: 'published',
        items: { $elemMatch: { name: item_name, claimed_by_id: null } },
      },
      {
        $set: {
          'items.$.claimed_by_id': claimant_id,
          'items.$.parent_name': String(parent_name).trim(),
          'items.$.parent_phone': String(parent_phone || '').trim(),
          'items.$.claimed_at': new Date(),
        },
      },
      { new: true }
    ).populate('branch_id', 'name');

    if (!updated) {
      // Distinguish "gone" from "closed / bad token".
      const ev = await GanEvent.findOne({ access_token: token }).populate('branch_id', 'name');
      if (!ev) return res.status(404).json({ error: 'האירוע לא נמצא' });
      if (ev.status !== 'published') return res.status(409).json({ error: 'האירוע נסגר לשריונים' });
      return res.status(409).json({ error: 'הפריט הזה כבר נתפס — רענן ובחר פריט אחר' });
    }
    res.json(publicEventView(updated, { claimant_id, phone: parent_phone }));
  } catch (error) { next(error); }
}

async function releaseItem(req, res, next) {
  try {
    const { token } = req.params;
    const { claimant_id, slot_id, parent_phone } = req.body || {};
    if (!slot_id) return res.status(400).json({ error: 'לא נבחר פריט' });

    // Only the owner may release — match by claimant_id (same device) or phone.
    const or = [];
    if (claimant_id) or.push({ claimed_by_id: claimant_id });
    if (digits(parent_phone)) or.push({ parent_phone: String(parent_phone).trim() });
    if (!or.length) return res.status(400).json({ error: 'מזהה משתמש חסר' });

    const updated = await GanEvent.findOneAndUpdate(
      {
        access_token: token,
        status: 'published',
        items: { $elemMatch: { _id: slot_id, $or: or } },
      },
      {
        $set: {
          'items.$.claimed_by_id': null,
          'items.$.parent_name': '',
          'items.$.parent_phone': '',
          'items.$.claimed_at': null,
        },
      },
      { new: true }
    ).populate('branch_id', 'name');

    if (!updated) return res.status(409).json({ error: 'לא ניתן לבטל את השריון' });
    res.json(publicEventView(updated, { claimant_id, phone: parent_phone }));
  } catch (error) { next(error); }
}

module.exports = {
  getRegistrationForm, submitSignature, storeSignedContract, uploadDocument,
  getEvent, claimItem, releaseItem,
};
