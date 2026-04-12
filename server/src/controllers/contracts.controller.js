const { Registration } = require('../models');
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

module.exports = { preview, generate, download };
