const { Registration, Classroom, Child, Archive, Collection, ContractVersion } = require('../models');
const { generateUniqueId, generateAccessToken } = require('../utils/id-generator');
const { normalizeYear, getAcademicYears, getAcademicYearStr } = require('../services/academic-year.service');
const { getBranchFilter } = require('../utils/branch-filter');
const fileStorage = require('../services/file-storage.service');
const env = require('../config/env');

async function getAll(req, res, next) {
  try {
    const { status, year } = req.query;

    // Lazy migration: any signed reg that already advanced past contract
    // signing (status=docs_uploaded) heals to completed; signed regs still
    // on contract_signed advance only when card data is present. The signed
    // signature on its own is treated as sufficient when the reg is on
    // docs_uploaded — that status was reached only after the card flow ran.
    try {
      const stuck = await Registration.find({
        agreement_signed: true,
        $or: [
          { status: 'docs_uploaded' },
          {
            status: 'contract_signed',
            'configuration.registration_card': { $exists: true, $ne: null },
          },
        ],
      });
      for (const r of stuck) {
        r.status = 'completed';
        r.card_completed = true;
        await r.save();
        const academicYear = getAcademicYearStr(r.start_date)
          || getAcademicYears().current.range;
        const card = (r.configuration && r.configuration.registration_card) || {};
        const existingChild = await Child.findOne({ registration_id: r._id });
        const childPayload = {
          child_name: r.child_name,
          child_id_number: card.childIdNumber || null,
          birth_date: r.child_birth_date,
          classroom_id: r.classroom_id,
          parent_name: r.parent_name,
          parent_id_number: r.parent_id_number || card.parent1Id || null,
          phone: r.parent_phone,
          email: r.parent_email,
          parent2_name: card.parent2Name || null,
          parent2_id_number: card.parent2Id || null,
          parent2_phone: card.parent2Phone || null,
          parent2_email: card.parent2Email || null,
          address: card.address || null,
          medical_alerts: card.medicalInfo || (r.configuration && r.configuration.medical_alerts) || null,
          allergies: card.allergies || null,
          emergency_contact: card.emergencyContact || null,
          emergency_phone: card.emergencyPhone || null,
          notes: card.notes || null,
          academic_year: academicYear,
          is_active: true,
        };
        if (existingChild) {
          Object.assign(existingChild, childPayload);
          await existingChild.save();
        } else {
          await Child.create({ registration_id: r._id, ...childPayload });
        }
      }
    } catch (migErr) {
      console.error('Lazy completion migration failed:', migErr.message);
    }

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

    // Auto-capture previous fee when a forward-dated price change is applied,
    // so the collections view bills the old fee for months before
    // fee_effective_from instead of applying the new fee retroactively.
    const monthlyFeeProvided = updates.monthly_fee !== undefined
      && Number(updates.monthly_fee) !== Number(existing.monthly_fee);
    if (monthlyFeeProvided && updates.fee_effective_from && updates.previous_monthly_fee === undefined) {
      updates.previous_monthly_fee = existing.monthly_fee;
    }
    // Clearing the price-change point: if the manager removes
    // fee_effective_from, drop previous_monthly_fee too — the new fee then
    // applies for the whole year.
    if (updates.fee_effective_from === null || updates.fee_effective_from === '') {
      updates.previous_monthly_fee = null;
    }

    // Detect material contract-affecting field changes for archiving the
    // current signed contract as a historical version. We DO NOT delete the
    // signature on the active registration — the existing contract stays
    // valid until the manager explicitly re-issues one.
    const contractFields = ['start_date', 'end_date', 'child_name', 'classroom_id', 'monthly_fee', 'registration_fee'];
    const contractFieldChanged = contractFields.some(
      field => updates[field] !== undefined && String(updates[field]) !== String(existing[field])
    );
    const shouldArchive = contractFieldChanged && existing.agreement_signed;

    if (shouldArchive) {
      try {
        const classroom = existing.classroom_id
          ? await Classroom.findById(existing.classroom_id).select('name').lean()
          : null;
        const lastVersion = await ContractVersion.findOne({ registration_id: existing._id })
          .sort({ version: -1 }).select('version').lean();
        const nextVersion = (lastVersion?.version || 0) + 1;

        await ContractVersion.create({
          registration_id: existing._id,
          version: nextVersion,
          contract_pdf_path: existing.contract_pdf_path,
          signature_data: existing.signature_data,
          agreement_signed: existing.agreement_signed,
          snapshot: {
            child_name: existing.child_name,
            parent_name: existing.parent_name,
            parent_id_number: existing.parent_id_number,
            classroom_name: classroom?.name || null,
            monthly_fee: existing.monthly_fee,
            registration_fee: existing.registration_fee,
            start_date: existing.start_date,
            end_date: existing.end_date,
            configuration: existing.configuration,
          },
          reason: contractFields.filter(f => updates[f] !== undefined && String(updates[f]) !== String(existing[f])).join(', '),
        });

        // Trim history: keep only the most recent 4 versions per registration.
        const all = await ContractVersion.find({ registration_id: existing._id })
          .sort({ archived_at: -1 }).select('_id').lean();
        if (all.length > 4) {
          const idsToRemove = all.slice(4).map(v => v._id);
          await ContractVersion.deleteMany({ _id: { $in: idsToRemove } });
        }
      } catch (archiveErr) {
        console.error('Failed to archive contract version:', archiveErr.message);
      }
    }

    const updated = await Registration.findByIdAndUpdate(id, updates, { new: true })
      .populate('classroom_id', 'name')
      .lean();

    updated.id = updated._id;
    updated.classroom_name = updated.classroom_id?.name || null;
    updated.classroom_id = updated.classroom_id?._id || updated.classroom_id;

    res.json({ registration: updated, contractArchived: shouldArchive });
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

async function listContractVersions(req, res, next) {
  try {
    const { id } = req.params;
    const versions = await ContractVersion.find({ registration_id: id })
      .sort({ archived_at: -1 })
      .lean();
    res.json({
      versions: versions.map(v => ({
        id: v._id,
        version: v.version,
        archived_at: v.archived_at,
        reason: v.reason,
        agreement_signed: v.agreement_signed,
        has_pdf: !!v.contract_pdf_path,
        snapshot: v.snapshot,
      })),
    });
  } catch (error) {
    next(error);
  }
}

async function downloadContractVersion(req, res, next) {
  try {
    const { versionId } = req.params;
    const version = await ContractVersion.findById(versionId).lean();
    if (!version) {
      return res.status(404).json({ error: 'Contract version not found' });
    }
    if (version.contract_pdf_path) {
      try {
        const url = await fileStorage.getPresignedUrl(version.contract_pdf_path, 600);
        return res.json({ url });
      } catch (err) {
        console.error('Presigned URL failed for version, falling back:', err.message);
      }
    }
    // Live render from snapshot.
    const { generateContractHTML } = require('../services/contract-pdf.service');
    const data = {
      ...(version.snapshot || {}),
      classroom: version.snapshot?.classroom_name || null,
      signature_data: version.signature_data,
    };
    const html = generateContractHTML(data);
    res.json({ html, filename: `contract_v${version.version}.html` });
  } catch (error) {
    next(error);
  }
}

async function downloadContract(req, res, next) {
  try {
    const { id } = req.params;
    const registration = await Registration.findById(id).populate('classroom_id', 'name');
    if (!registration) {
      return res.status(404).json({ error: 'Registration not found' });
    }
    // If we have a stored PDF/HTML in R2, return its presigned URL.
    if (registration.contract_pdf_path) {
      try {
        const url = await fileStorage.getPresignedUrl(registration.contract_pdf_path, 600);
        return res.json({ url });
      } catch (storageErr) {
        console.error('Presigned URL failed, falling back to live render:', storageErr.message);
      }
    }
    // Live fallback: render HTML now using current registration data + saved
    // signature. Works even if R2 isn't configured.
    const { generateContractHTML } = require('../services/contract-pdf.service');
    const data = {
      ...registration.toObject(),
      classroom: registration.classroom_id?.name || null,
    };
    const html = generateContractHTML(data);
    res.json({ html, filename: `contract_${registration.unique_id}.html` });
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
  finalizeManual, downloadContract, listContractVersions, downloadContractVersion,
  fixOrphanBranch,
};
