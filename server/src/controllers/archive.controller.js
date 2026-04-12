const { Archive, Registration, Child, Collection, Classroom } = require('../models');
const { normalizeYear, getAcademicYears, getAcademicYearStr } = require('../services/academic-year.service');

async function getAll(req, res, next) {
  try {
    const { type, year } = req.query;
    let filter = {};

    if (type && (type === 'signed' || type === 'unsigned')) {
      filter.archive_type = type;
    }
    if (year) {
      filter.academic_year = normalizeYear(year);
    }

    const archives = await Archive.find(filter).sort({ archived_at: -1 }).lean();

    const parsed = archives.map(a => ({
      ...a,
      id: a._id,
    }));

    res.json({ archives: parsed });
  } catch (error) {
    next(error);
  }
}

async function create(req, res, next) {
  try {
    const { registration_id } = req.body;
    if (!registration_id) {
      return res.status(400).json({ error: 'registration_id is required' });
    }

    const registration = await Registration.findById(registration_id)
      .populate('classroom_id', 'name').lean();
    if (!registration) {
      return res.status(404).json({ error: 'Registration not found' });
    }

    const archiveType = registration.agreement_signed ? 'signed' : 'unsigned';
    const academicYear = getAcademicYearStr(registration.start_date) || '';

    const archiveRecord = await Archive.create({
      registration_id: registration._id,
      archive_type: archiveType,
      original_data: registration,
      child_name: registration.child_name,
      classroom_name: registration.classroom_id?.name || null,
      academic_year: academicYear,
      archived_by: req.user?._id || req.user?.id || null,
    });

    await Child.deleteMany({ registration_id });
    await Collection.deleteMany({ registration_id });
    await Registration.findByIdAndDelete(registration_id);

    res.status(201).json({
      message: 'Registration archived successfully',
      archive: { ...archiveRecord.toObject(), id: archiveRecord._id, original_data: registration },
    });
  } catch (error) {
    next(error);
  }
}

async function restore(req, res, next) {
  try {
    const { id } = req.params;
    const archive = await Archive.findById(id);
    if (!archive) {
      return res.status(404).json({ error: 'Archive record not found' });
    }
    if (archive.restored_at) {
      return res.status(400).json({ error: 'This record has already been restored' });
    }

    const originalData = archive.original_data;

    const restoredRegistration = await Registration.create({
      unique_id: originalData.unique_id,
      child_name: originalData.child_name,
      child_birth_date: originalData.child_birth_date,
      classroom_id: originalData.classroom_id || null,
      parent_name: originalData.parent_name,
      parent_id_number: originalData.parent_id_number,
      parent_phone: originalData.parent_phone,
      parent_email: originalData.parent_email,
      monthly_fee: originalData.monthly_fee,
      registration_fee: originalData.registration_fee,
      start_date: originalData.start_date,
      end_date: originalData.end_date,
      status: originalData.status || 'link_generated',
      agreement_signed: originalData.agreement_signed || false,
      card_completed: originalData.card_completed || false,
      configuration: originalData.configuration || {},
      access_token: originalData.access_token,
      signature_data: originalData.signature_data,
      contract_pdf_path: originalData.contract_pdf_path,
    });

    if (archive.archive_type === 'signed' || originalData.status === 'completed') {
      const academicYear = getAcademicYearStr(originalData.start_date)
        || getAcademicYears().current.range;

      await Child.create({
        registration_id: restoredRegistration._id,
        child_name: originalData.child_name,
        birth_date: originalData.child_birth_date,
        classroom_id: originalData.classroom_id || null,
        parent_name: originalData.parent_name,
        phone: originalData.parent_phone,
        email: originalData.parent_email,
        academic_year: academicYear,
        is_active: true,
      });
    }

    archive.restored_at = new Date();
    archive.restored_by = req.user?._id || req.user?.id || null;
    await archive.save();

    res.json({
      message: 'Registration restored successfully',
      registration: { ...restoredRegistration.toObject(), id: restoredRegistration._id },
    });
  } catch (error) {
    next(error);
  }
}

async function remove(req, res, next) {
  try {
    const { id } = req.params;
    const archive = await Archive.findById(id);
    if (!archive) {
      return res.status(404).json({ error: 'Archive record not found' });
    }

    await Archive.findByIdAndDelete(id);
    res.json({ message: 'Archive record permanently deleted', id });
  } catch (error) {
    next(error);
  }
}

module.exports = { getAll, create, archive: create, restore, remove };
