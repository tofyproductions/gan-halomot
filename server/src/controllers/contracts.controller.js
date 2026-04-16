const { Registration, Contract } = require('../models');
const { generateContractHTML, generateContractPDF } = require('../services/contract-pdf.service');
const fileStorage = require('../services/file-storage.service');

async function preview(req, res, next) {
  try {
    const { registrationId } = req.params;
    const registration = await Registration.findById(registrationId)
      .populate('classroom_id', 'name').lean();

    if (!registration) {
      return res.status(404).json({ error: 'Registration not found' });
    }

    registration.classroom = registration.classroom_id?.name || null;
    const html = generateContractHTML(registration);
    res.type('html').send(html);
  } catch (error) {
    next(error);
  }
}

async function generate(req, res, next) {
  try {
    const { registrationId } = req.params;
    const registration = await Registration.findById(registrationId)
      .populate('classroom_id', 'name').lean();

    if (!registration) {
      return res.status(404).json({ error: 'Registration not found' });
    }

    registration.classroom = registration.classroom_id?.name || null;

    const pdfBuffer = await generateContractPDF(registration);
    const key = `contracts/${registration.unique_id}_contract_${Date.now()}.pdf`;
    await fileStorage.upload(pdfBuffer, key, 'application/pdf');

    await Registration.findByIdAndUpdate(registrationId, { contract_pdf_path: key });

    const url = await fileStorage.getPresignedUrl(key, 3600);
    res.json({ message: 'Contract PDF generated successfully', contract_pdf_path: key, url });
  } catch (error) {
    next(error);
  }
}

async function download(req, res, next) {
  try {
    const { registrationId } = req.params;
    const registration = await Registration.findById(registrationId)
      .select('contract_pdf_path child_name unique_id').lean();

    if (!registration) {
      return res.status(404).json({ error: 'Registration not found' });
    }
    if (!registration.contract_pdf_path) {
      return res.status(404).json({ error: 'Contract PDF has not been generated yet' });
    }

    const url = await fileStorage.getPresignedUrl(registration.contract_pdf_path, 600);
    res.redirect(url);
  } catch (error) {
    next(error);
  }
}

// --- Contract document management (upload/list/view) ---

async function listContracts(req, res, next) {
  try {
    const { registration_id, employee_id } = req.query;
    const filter = {};
    if (employee_id === 'me') {
      filter.employee_id = req.user.id;
    } else if (employee_id) {
      filter.employee_id = employee_id;
    }
    if (registration_id) filter.registration_id = registration_id;

    const contracts = await Contract.find(filter)
      .select('-file_data')
      .sort({ created_at: -1 })
      .lean();

    const withUrls = contracts.map(c => ({
      ...c,
      file_url: `/api/contracts/doc/${c._id}/file`,
    }));

    res.json({ contracts: withUrls });
  } catch (error) {
    next(error);
  }
}

async function uploadContract(req, res, next) {
  try {
    const { registration_id, employee_id, type, doc_type, file_name, file_data, file_mimetype, notes, branch_id } = req.body;

    if (!file_data || !file_name) {
      return res.status(400).json({ error: 'קובץ ושם קובץ נדרשים' });
    }

    const contract = await Contract.create({
      registration_id: registration_id || null,
      employee_id: employee_id || null,
      branch_id: branch_id || null,
      type: type || 'enrollment',
      doc_type: doc_type || 'other',
      file_name,
      file_data,
      file_mimetype: file_mimetype || 'application/pdf',
      notes: notes || null,
    });

    res.status(201).json({
      contract: { ...contract.toObject(), file_data: undefined, file_url: `/api/contracts/doc/${contract._id}/file` },
    });
  } catch (error) {
    next(error);
  }
}

async function getContractFile(req, res, next) {
  try {
    const contract = await Contract.findById(req.params.id);
    if (!contract) return res.status(404).json({ error: 'חוזה לא נמצא' });

    const buffer = Buffer.from(contract.file_data, 'base64');
    res.setHeader('Content-Type', contract.file_mimetype || 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${contract.file_name}"`);
    res.send(buffer);
  } catch (error) {
    next(error);
  }
}

async function deleteContract(req, res, next) {
  try {
    const contract = await Contract.findByIdAndDelete(req.params.id);
    if (!contract) return res.status(404).json({ error: 'חוזה לא נמצא' });
    res.json({ message: 'חוזה נמחק' });
  } catch (error) {
    next(error);
  }
}

module.exports = { preview, generate, download, listContracts, uploadContract, getContractFile, deleteContract };
