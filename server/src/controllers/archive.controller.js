const db = require('../config/database');
const { normalizeYear, getAcademicYears, getAcademicYearStr } = require('../services/academic-year.service');

/**
 * GET /api/archive?type=signed&year=2025
 * Return archived records filtered by type and year
 */
async function getAll(req, res, next) {
  try {
    const { type, year } = req.query;

    let query = db('archives').orderBy('archived_at', 'desc');

    if (type && (type === 'signed' || type === 'unsigned')) {
      query = query.where('archive_type', type);
    }

    if (year) {
      query = query.where('academic_year', normalizeYear(year));
    }

    const archives = await query;

    // Parse original_data JSON
    const parsed = archives.map(a => ({
      ...a,
      original_data: typeof a.original_data === 'string'
        ? JSON.parse(a.original_data)
        : a.original_data,
    }));

    res.json({ archives: parsed });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/archive
 * Move a registration to archives with JSONB snapshot
 * Cascade delete linked child record
 */
async function create(req, res, next) {
  try {
    const { registration_id } = req.body;

    if (!registration_id) {
      return res.status(400).json({ error: 'registration_id is required' });
    }

    const registration = await db('registrations')
      .select('registrations.*', 'classrooms.name as classroom_name')
      .leftJoin('classrooms', 'registrations.classroom_id', 'classrooms.id')
      .where('registrations.id', registration_id)
      .first();

    if (!registration) {
      return res.status(404).json({ error: 'Registration not found' });
    }

    const archiveType = registration.agreement_signed ? 'signed' : 'unsigned';
    const academicYear = getAcademicYearStr(registration.start_date) || '';

    let archiveRecord;

    await db.transaction(async trx => {
      // Insert into archives
      [archiveRecord] = await trx('archives')
        .insert({
          registration_id: registration.id,
          archive_type: archiveType,
          original_data: JSON.stringify(registration),
          child_name: registration.child_name,
          classroom_name: registration.classroom_name || null,
          academic_year: academicYear,
          archived_by: req.user ? req.user.id : null,
        })
        .returning('*');

      // Cascade delete child record
      await trx('children').where({ registration_id }).delete();

      // Delete collections and collection_months (cascade handled by FK)
      await trx('collections').where({ registration_id }).delete();

      // Delete the registration
      await trx('registrations').where({ id: registration_id }).delete();
    });

    res.status(201).json({
      message: 'Registration archived successfully',
      archive: {
        ...archiveRecord,
        original_data: registration,
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/archive/:id/restore
 * Move from archives back to registrations
 * Recreate child record if the registration was signed
 */
async function restore(req, res, next) {
  try {
    const { id } = req.params;

    const archive = await db('archives').where({ id }).first();
    if (!archive) {
      return res.status(404).json({ error: 'Archive record not found' });
    }

    if (archive.restored_at) {
      return res.status(400).json({ error: 'This record has already been restored' });
    }

    const originalData = typeof archive.original_data === 'string'
      ? JSON.parse(archive.original_data)
      : archive.original_data;

    let restoredRegistration;

    await db.transaction(async trx => {
      // Re-insert into registrations (without auto-generated fields)
      const regData = {
        unique_id: originalData.unique_id,
        child_name: originalData.child_name,
        child_birth_date: originalData.child_birth_date,
        classroom_id: originalData.classroom_id,
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
        configuration: typeof originalData.configuration === 'object'
          ? JSON.stringify(originalData.configuration)
          : (originalData.configuration || '{}'),
        access_token: originalData.access_token,
        signature_data: originalData.signature_data,
        contract_pdf_path: originalData.contract_pdf_path,
      };

      [restoredRegistration] = await trx('registrations')
        .insert(regData)
        .returning('*');

      // Recreate child record if the registration was signed/completed
      if (archive.archive_type === 'signed' || originalData.status === 'completed') {
        const academicYear = getAcademicYearStr(originalData.start_date)
          || getAcademicYears().current.range;

        await trx('children').insert({
          registration_id: restoredRegistration.id,
          child_name: originalData.child_name,
          birth_date: originalData.child_birth_date,
          classroom_id: originalData.classroom_id,
          parent_name: originalData.parent_name,
          phone: originalData.parent_phone,
          email: originalData.parent_email,
          academic_year: academicYear,
          is_active: true,
        });
      }

      // Mark archive as restored
      await trx('archives').where({ id }).update({
        restored_at: new Date(),
        restored_by: req.user ? req.user.id : null,
      });
    });

    res.json({
      message: 'Registration restored successfully',
      registration: restoredRegistration,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * DELETE /api/archive/:id
 * Permanent delete from archives
 */
async function remove(req, res, next) {
  try {
    const { id } = req.params;

    const archive = await db('archives').where({ id }).first();
    if (!archive) {
      return res.status(404).json({ error: 'Archive record not found' });
    }

    await db('archives').where({ id }).delete();

    res.json({ message: 'Archive record permanently deleted', id: parseInt(id) });
  } catch (error) {
    next(error);
  }
}

module.exports = { getAll, create, archive: create, restore, remove };
