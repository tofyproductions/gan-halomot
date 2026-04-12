const db = require('../config/database');
const { generateUniqueId, generateAccessToken } = require('../utils/id-generator');
const { normalizeYear, getAcademicYears, getAcademicYearStr } = require('../services/academic-year.service');
const env = require('../config/env');

/**
 * GET /api/registration?status=link_generated&year=2025
 * Return all registrations with optional filters
 */
async function getAll(req, res, next) {
  try {
    const { status, year } = req.query;
    const academicYears = getAcademicYears();

    let query = db('registrations')
      .select(
        'registrations.*',
        'classrooms.name as classroom_name'
      )
      .leftJoin('classrooms', 'registrations.classroom_id', 'classrooms.id');

    if (status) {
      query = query.where('registrations.status', status);
    }

    if (year) {
      const normalized = normalizeYear(year);
      const [y1] = normalized.split('-').map(Number);
      if (y1) {
        query = query.where(function () {
          this.whereBetween('registrations.start_date', [`${y1}-09-01`, `${y1 + 1}-08-31`]);
        });
      }
    }

    const registrations = await query.orderBy('registrations.created_at', 'desc');

    // Format dates for frontend
    const formatted = registrations.map(r => ({
      ...r,
      start_date_formatted: r.start_date
        ? new Date(r.start_date).toLocaleDateString('he-IL')
        : null,
      end_date_formatted: r.end_date
        ? new Date(r.end_date).toLocaleDateString('he-IL')
        : null,
    }));

    res.json({ registrations: formatted });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/registration/:id
 * Return single registration by DB id or unique_id
 */
async function getById(req, res, next) {
  try {
    const { id } = req.params;

    let registration;
    if (isNaN(id)) {
      // unique_id lookup
      registration = await db('registrations')
        .select('registrations.*', 'classrooms.name as classroom_name')
        .leftJoin('classrooms', 'registrations.classroom_id', 'classrooms.id')
        .where('registrations.unique_id', id)
        .first();
    } else {
      registration = await db('registrations')
        .select('registrations.*', 'classrooms.name as classroom_name')
        .leftJoin('classrooms', 'registrations.classroom_id', 'classrooms.id')
        .where('registrations.id', id)
        .first();
    }

    if (!registration) {
      return res.status(404).json({ error: 'Registration not found' });
    }

    // Parse configuration JSON if stored as string
    if (typeof registration.configuration === 'string') {
      try {
        registration.configuration = JSON.parse(registration.configuration);
      } catch {
        registration.configuration = {};
      }
    }

    res.json({ registration });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/registration
 * Create a new registration
 */
async function create(req, res, next) {
  try {
    const {
      child_name, child_birth_date, classroom_id,
      parent_name, parent_id_number, parent_phone, parent_email,
      monthly_fee, registration_fee, start_date, end_date,
      configuration,
    } = req.body;

    if (!child_name || !parent_name || !monthly_fee || !start_date || !end_date) {
      return res.status(400).json({
        error: 'Missing required fields: child_name, parent_name, monthly_fee, start_date, end_date',
      });
    }

    const unique_id = generateUniqueId('REG');
    const access_token = generateAccessToken();

    const [inserted] = await db('registrations')
      .insert({
        unique_id,
        child_name,
        child_birth_date: child_birth_date || null,
        classroom_id: classroom_id || null,
        parent_name,
        parent_id_number: parent_id_number || null,
        parent_phone: parent_phone || null,
        parent_email: parent_email || null,
        monthly_fee,
        registration_fee: registration_fee || 0,
        start_date,
        end_date,
        status: 'link_generated',
        access_token,
        configuration: JSON.stringify(configuration || {}),
      })
      .returning('*');

    res.status(201).json({ registration: inserted });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/registration/:id
 * Update registration - reset signature if key fields change
 */
async function update(req, res, next) {
  try {
    const { id } = req.params;
    const updates = req.body;

    const existing = await db('registrations').where({ id }).first();
    if (!existing) {
      return res.status(404).json({ error: 'Registration not found' });
    }

    // Remove read-only fields
    delete updates.id;
    delete updates.unique_id;
    delete updates.created_at;

    // If key contract fields changed, reset the signature
    const signatureFields = ['monthly_fee', 'start_date', 'end_date', 'child_name', 'classroom_id'];
    const signatureChanged = signatureFields.some(
      field => updates[field] !== undefined && String(updates[field]) !== String(existing[field])
    );

    if (signatureChanged && existing.agreement_signed) {
      updates.agreement_signed = false;
      updates.signature_data = null;
      updates.contract_pdf_path = null;
      updates.status = 'link_generated';
    }

    // Stringify configuration if it's an object
    if (updates.configuration && typeof updates.configuration === 'object') {
      updates.configuration = JSON.stringify(updates.configuration);
    }

    updates.updated_at = new Date();

    await db('registrations').where({ id }).update(updates);

    const updated = await db('registrations')
      .select('registrations.*', 'classrooms.name as classroom_name')
      .leftJoin('classrooms', 'registrations.classroom_id', 'classrooms.id')
      .where('registrations.id', id)
      .first();

    res.json({ registration: updated, signatureReset: signatureChanged });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/registration/:id/generate-link
 * Generate or refresh access token and return the parent-facing URL
 */
async function generateLink(req, res, next) {
  try {
    const { id } = req.params;

    const registration = await db('registrations').where({ id }).first();
    if (!registration) {
      return res.status(404).json({ error: 'Registration not found' });
    }

    const access_token = generateAccessToken();
    const token_expires_at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    await db('registrations').where({ id }).update({
      access_token,
      token_expires_at,
      updated_at: new Date(),
    });

    const link = `${env.FRONTEND_URL}/register/${access_token}`;

    res.json({
      link,
      access_token,
      expires_at: token_expires_at,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/registration/:id/activate
 * Set status=completed, create child record, sync classroom
 */
async function activate(req, res, next) {
  try {
    const { id } = req.params;

    const registration = await db('registrations')
      .select('registrations.*', 'classrooms.name as classroom_name')
      .leftJoin('classrooms', 'registrations.classroom_id', 'classrooms.id')
      .where('registrations.id', id)
      .first();

    if (!registration) {
      return res.status(404).json({ error: 'Registration not found' });
    }

    // Set registration to completed
    await db('registrations').where({ id }).update({
      status: 'completed',
      updated_at: new Date(),
    });

    // Determine academic year
    const academicYear = getAcademicYearStr(registration.start_date)
      || getAcademicYears().current.range;

    // Check if child already exists for this registration
    const existingChild = await db('children')
      .where({ registration_id: id })
      .first();

    let child;
    if (existingChild) {
      // Update existing child
      await db('children').where({ id: existingChild.id }).update({
        classroom_id: registration.classroom_id,
        is_active: true,
        updated_at: new Date(),
      });
      child = await db('children').where({ id: existingChild.id }).first();
    } else {
      // Create new child record
      const [newChild] = await db('children')
        .insert({
          registration_id: parseInt(id),
          child_name: registration.child_name,
          birth_date: registration.child_birth_date,
          classroom_id: registration.classroom_id,
          parent_name: registration.parent_name,
          phone: registration.parent_phone,
          email: registration.parent_email,
          academic_year: academicYear,
          is_active: true,
        })
        .returning('*');
      child = newChild;
    }

    res.json({
      message: 'Registration activated and child record created',
      registration: { ...registration, status: 'completed' },
      child,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * DELETE /api/registration/:id
 * Archive the registration, delete from registrations, cascade delete children
 */
async function remove(req, res, next) {
  try {
    const { id } = req.params;

    const registration = await db('registrations')
      .select('registrations.*', 'classrooms.name as classroom_name')
      .leftJoin('classrooms', 'registrations.classroom_id', 'classrooms.id')
      .where('registrations.id', id)
      .first();

    if (!registration) {
      return res.status(404).json({ error: 'Registration not found' });
    }

    const archiveType = registration.agreement_signed ? 'signed' : 'unsigned';
    const academicYear = getAcademicYearStr(registration.start_date) || '';

    await db.transaction(async trx => {
      // Archive the registration
      await trx('archives').insert({
        registration_id: registration.id,
        archive_type: archiveType,
        original_data: JSON.stringify(registration),
        child_name: registration.child_name,
        classroom_name: registration.classroom_name || null,
        academic_year: academicYear,
      });

      // Delete linked children
      await trx('children').where({ registration_id: id }).delete();

      // Delete the registration
      await trx('registrations').where({ id }).delete();
    });

    res.json({ message: 'Registration archived successfully', id: parseInt(id) });
  } catch (error) {
    next(error);
  }
}

module.exports = { getAll, getById, create, update, generateLink, activate, remove };
