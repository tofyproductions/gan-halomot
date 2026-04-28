const { Registration, Classroom, Child, Archive, Collection } = require('../models');
const { generateUniqueId, generateAccessToken } = require('../utils/id-generator');
const { normalizeYear, getAcademicYears, getAcademicYearStr } = require('../services/academic-year.service');
const { getBranchFilter } = require('../utils/branch-filter');
const fileStorage = require('../services/file-storage.service');
const env = require('../config/env');

async function getAll(req, res, next) {
  try {
    const { status, year } = req.query;

    let filter = { ...getBranchFilter(req) };
    if (status) filter.status = status;

    if (year) {
      const normalized = normalizeYear(year);
      const [y1] = normalized.split('-').map(Number);
      if (y1) {
        filter.start_date = { $gte: new Date(`${y1}-09-01`), $lte: new Date(`${y1 + 1}-08-31`) };
      }
    }

    const registrations = await Registration.find(filter)
      .populate('classroom_id', 'name')
      .sort({ created_at: -1 })
      .lean();

    const formatted = registrations.map(r => ({
      ...r,
      id: r._id,
      classroom_name: r.classroom_id?.name || null,
      classroom_id: r.classroom_id?._id || r.classroom_id,
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

async function getById(req, res, next) {
  try {
    const { id } = req.params;
    let registration;

    if (id.match(/^[0-9a-fA-F]{24}$/)) {
      registration = await Registration.findById(id).populate('classroom_id', 'name').lean();
    } else {
      registration = await Registration.findOne({ unique_id: id }).populate('classroom_id', 'name').lean();
    }

    if (!registration) {
      return res.status(404).json({ error: 'Registration not found' });
    }

    registration.id = registration._id;
    registration.classroom_name = registration.classroom_id?.name || null;
    registration.classroom_id = registration.classroom_id?._id || registration.classroom_id;

    res.json({ registration });
  } catch (error) {
    next(error);
  }
}

async function create(req, res, next) {
  try {
    const {
      child_name, child_birth_date, classroom_id, branch_id,
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

    // Fall back to the request's selected branch (?branch=...) if the
    // client didn't pass branch_id explicitly. Without this, new regs get
    // saved as branch_id=null and disappear from any branch-filtered list.
    const effectiveBranchId = branch_id || req.query.branch || null;

    const registration = await Registration.create({
      unique_id,
      branch_id: effectiveBranchId,
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
      configuration: configuration || {},
    });

    res.status(201).json({ registration: { ...registration.toObject(), id: registration._id } });
  } catch (error) {
    next(error);
  }
}

async function update(req, res, next) {
  try {
    const { id } = req.params;
    const updates = req.body;

    const existing = await Registration.findById(id);
    if (!existing) {
      return res.status(404).json({ error: 'Registration not found' });
    }

    delete updates._id;
    delete updates.id;
    delete updates.unique_id;
    delete updates.created_at;

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

    const updated = await Registration.findByIdAndUpdate(id, updates, { new: true })
      .populate('classroom_id', 'name')
      .lean();

    updated.id = updated._id;
    updated.classroom_name = updated.classroom_id?.name || null;
    updated.classroom_id = updated.classroom_id?._id || updated.classroom_id;

    res.json({ registration: updated, signatureReset: signatureChanged });
  } catch (error) {
    next(error);
  }
}

async function generateLink(req, res, next) {
  try {
    const { id } = req.params;
    const registration = await Registration.findById(id);
    if (!registration) {
      return res.status(404).json({ error: 'Registration not found' });
    }

    const access_token = generateAccessToken();
    const token_expires_at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    registration.access_token = access_token;
    registration.token_expires_at = token_expires_at;
    await registration.save();

    const link = `${env.FRONTEND_URL}/register/${access_token}`;
    res.json({ link, access_token, expires_at: token_expires_at });
  } catch (error) {
    next(error);
  }
}

async function activate(req, res, next) {
  try {
    const { id } = req.params;
    const registration = await Registration.findById(id).populate('classroom_id', 'name').lean();
    if (!registration) {
      return res.status(404).json({ error: 'Registration not found' });
    }

    await Registration.findByIdAndUpdate(id, { status: 'completed' });

    const academicYear = getAcademicYearStr(registration.start_date)
      || getAcademicYears().current.range;

    let child = await Child.findOne({ registration_id: id });

    if (child) {
      child.classroom_id = registration.classroom_id?._id || registration.classroom_id;
      child.is_active = true;
      await child.save();
    } else {
      child = await Child.create({
        registration_id: id,
        child_name: registration.child_name,
        birth_date: registration.child_birth_date,
        classroom_id: registration.classroom_id?._id || registration.classroom_id,
        parent_name: registration.parent_name,
        phone: registration.parent_phone,
        email: registration.parent_email,
        academic_year: academicYear,
        is_active: true,
      });
    }

    res.json({
      message: 'Registration activated and child record created',
      registration: { ...registration, id: registration._id, status: 'completed' },
      child,
    });
  } catch (error) {
    next(error);
  }
}

async function remove(req, res, next) {
  try {
    const { id } = req.params;
    const registration = await Registration.findById(id).populate('classroom_id', 'name').lean();
    if (!registration) {
      return res.status(404).json({ error: 'Registration not found' });
    }

    const archiveType = registration.agreement_signed ? 'signed' : 'unsigned';
    const academicYear = getAcademicYearStr(registration.start_date) || '';

    await Archive.create({
      registration_id: registration._id,
      archive_type: archiveType,
      original_data: registration,
      child_name: registration.child_name,
      classroom_name: registration.classroom_id?.name || null,
      academic_year: academicYear,
    });

    await Child.deleteMany({ registration_id: id });
    await Collection.deleteMany({ registration_id: id });
    await Registration.findByIdAndDelete(id);

    res.json({ message: 'Registration archived successfully', id });
  } catch (error) {
    next(error);
  }
}

async function finalizeManual(req, res, next) {
  try {
    const { id } = req.params;
    const registration = await Registration.findById(id);
    if (!registration) {
      return res.status(404).json({ error: 'Registration not found' });
    }

    // Optional signed contract file (PDF/image). Best-effort upload to R2.
    if (req.file) {
      try {
        const key = `contracts/${registration.unique_id}_manual_${Date.now()}_${req.file.originalname}`;
        await fileStorage.upload(req.file.buffer, key, req.file.mimetype);
        registration.contract_pdf_path = key;
      } catch (uploadErr) {
        console.error('Manual contract upload failed:', uploadErr.message);
      }
    }

    registration.agreement_signed = true;
    registration.card_completed = true;
    registration.status = 'completed';

    const config = registration.configuration || {};
    config.manual_import = true;
    registration.configuration = config;

    await registration.save();

    // Create Child if missing
    const academicYear = getAcademicYearStr(registration.start_date)
      || getAcademicYears().current.range;
    const existingChild = await Child.findOne({ registration_id: registration._id });
    if (!existingChild) {
      await Child.create({
        registration_id: registration._id,
        child_name: registration.child_name,
        birth_date: registration.child_birth_date,
        classroom_id: registration.classroom_id,
        parent_name: registration.parent_name,
        phone: registration.parent_phone,
        email: registration.parent_email,
        academic_year: academicYear,
        is_active: true,
      });
    } else if (!existingChild.is_active) {
      existingChild.is_active = true;
      await existingChild.save();
    }

    res.json({
      message: 'Registration finalized manually',
      registration_id: registration._id,
      contract_pdf_path: registration.contract_pdf_path,
    });
  } catch (error) {
    next(error);
  }
}

async function downloadContract(req, res, next) {
  try {
    const { id } = req.params;
    const registration = await Registration.findById(id);
    if (!registration) {
      return res.status(404).json({ error: 'Registration not found' });
    }
    if (!registration.contract_pdf_path) {
      return res.status(404).json({ error: 'No contract on file' });
    }
    const url = await fileStorage.getPresignedUrl(registration.contract_pdf_path, 600);
    // Return URL as JSON; frontend opens it. Avoids axios-following-redirect quirks.
    res.json({ url });
  } catch (error) {
    next(error);
  }
}

async function fixOrphanBranch(req, res, next) {
  try {
    const targetBranchId = req.body.branch_id || req.query.branch;
    if (!targetBranchId) {
      return res.status(400).json({ error: 'branch_id required' });
    }
    const result = await Registration.updateMany(
      { $or: [{ branch_id: null }, { branch_id: { $exists: false } }] },
      { $set: { branch_id: targetBranchId } }
    );
    res.json({ updated: result.modifiedCount, branch_id: targetBranchId });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getAll, getById, create, update, generateLink, activate, remove,
  finalizeManual, downloadContract, fixOrphanBranch,
};
