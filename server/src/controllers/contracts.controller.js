const db = require('../config/database');
const { generateContractHTML, generateContractPDF } = require('../services/contract-pdf.service');
const fileStorage = require('../services/file-storage.service');

/**
 * GET /api/contracts/:registrationId/preview
 * Generate contract HTML preview
 */
async function preview(req, res, next) {
  try {
    const { registrationId } = req.params;

    const registration = await db('registrations')
      .select('registrations.*', 'classrooms.name as classroom')
      .leftJoin('classrooms', 'registrations.classroom_id', 'classrooms.id')
      .where('registrations.id', registrationId)
      .first();

    if (!registration) {
      return res.status(404).json({ error: 'Registration not found' });
    }

    const html = generateContractHTML(registration);

    res.type('html').send(html);
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/contracts/:registrationId/generate
 * Generate PDF, save to R2, update registration, return URL
 */
async function generate(req, res, next) {
  try {
    const { registrationId } = req.params;

    const registration = await db('registrations')
      .select('registrations.*', 'classrooms.name as classroom')
      .leftJoin('classrooms', 'registrations.classroom_id', 'classrooms.id')
      .where('registrations.id', registrationId)
      .first();

    if (!registration) {
      return res.status(404).json({ error: 'Registration not found' });
    }

    // Generate PDF buffer
    const pdfBuffer = await generateContractPDF(registration);

    // Upload to R2
    const key = `contracts/${registration.unique_id}_contract_${Date.now()}.pdf`;
    await fileStorage.upload(pdfBuffer, key, 'application/pdf');

    // Update registration with contract path
    await db('registrations').where({ id: registrationId }).update({
      contract_pdf_path: key,
      updated_at: new Date(),
    });

    // Get presigned URL for immediate access
    const url = await fileStorage.getPresignedUrl(key, 3600);

    res.json({
      message: 'Contract PDF generated successfully',
      contract_pdf_path: key,
      url,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/contracts/:registrationId/download
 * Download contract PDF from R2 - stream or redirect to presigned URL
 */
async function download(req, res, next) {
  try {
    const { registrationId } = req.params;

    const registration = await db('registrations')
      .select('contract_pdf_path', 'child_name', 'unique_id')
      .where({ id: registrationId })
      .first();

    if (!registration) {
      return res.status(404).json({ error: 'Registration not found' });
    }

    if (!registration.contract_pdf_path) {
      return res.status(404).json({ error: 'Contract PDF has not been generated yet' });
    }

    // Redirect to presigned URL
    const url = await fileStorage.getPresignedUrl(registration.contract_pdf_path, 600);
    res.redirect(url);
  } catch (error) {
    next(error);
  }
}

module.exports = { preview, generate, download };
