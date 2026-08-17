const XLSX = require('xlsx');
const {
  ExternalEnrollment, Registration, Child, Collection, Branch, BranchPricing, Classroom,
  EnrollmentImport,
} = require('../models');
const {
  parseSheet, missingColumns, COLUMNS, AGE_GROUPS,
} = require('../services/clicktac.service');
const {
  normalizeYear, enrollmentYear, hebrewYearForStart, academicYearOf, normalizeChildName,
} = require('../services/academic-year.service');
const { generateUniqueId } = require('../utils/id-generator');
const { getBranchFilter } = require('../utils/branch-filter');

/**
 * קליטת רישומים מקליקטאק — the review queue between an external export and
 * this system's live tables.
 *
 * Nothing here writes a Registration on its own. A spreadsheet of 77 children
 * is not something to trust blind: the branch is not in the file, the tuition
 * is not in the file, and roughly half the rows are children who already exist
 * somewhere. Every row lands as an ExternalEnrollment, gets matched against
 * what is already here, and becomes a registration only when someone says so.
 */

/** The ת"ז of a child, wherever this system happens to keep it. */
function childIdOf(reg, child) {
  return String(child?.child_id_number || reg?.configuration?.registration_card?.childIdNumber || '')
    .replace(/\D/g, '');
}

const dayKey = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

/**
 * The age group a child is actually placed in.
 *
 * A manager's decision first — it was made against the child's real age on 1
 * September and it is the only one of the three that is a placement rather
 * than a bracket. Then the computed group, then ClickTac's own.
 */
function effectiveAgeGroup(doc) {
  return doc.placement?.age_group_override
    || doc.computed?.age_group
    || doc.child?.age_group
    || '';
}

/**
 * The fields whose change between two exports is worth recording.
 *
 * The list is short on purpose: an operator re-uploading in August wants to
 * see that somebody cancelled or that a signature came in, not that a phone
 * number gained a dash.
 */
const TRACKED = [
  { path: 'enrollment.status', label: 'סטטוס' },
  { path: 'enrollment.second_signer', label: 'חותם שני' },
  { path: 'enrollment.continuing', label: 'ממשיך' },
  { path: 'child.full_name', label: 'שם' },
  { path: 'child.birth_date', label: 'תאריך לידה' },
  { path: 'child.age_group', label: 'שכבת גיל' },
  { path: 'parent1.phone', label: 'טלפון הורה 1' },
  { path: 'parent2.phone', label: 'טלפון הורה 2' },
  { path: 'enrollment.receipt_number', label: 'מספר קבלה' },
];

const at = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
const asText = (v) => {
  if (v == null || v === '') return '—';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'boolean') return v ? 'כן' : 'לא';
  return String(v);
};

/** What changed between the stored record and the freshly parsed one. */
function diffFields(existing, doc) {
  return TRACKED
    .map(({ path, label }) => ({ label, from: asText(at(existing, path)), to: asText(at(doc, path)) }))
    .filter(c => c.from !== c.to);
}

/**
 * Tie an imported row to a registration that already exists.
 *
 * ת"ז first — it is unique in every export seen and it is the child's own.
 * Name + birth date second, because this system barely stores child ID numbers
 * (one record in seventy), so for almost every existing child the ת"ז cannot
 * match anything and the fallback is the only thing that will.
 */
function matchExisting(doc, registrations, childByReg) {
  const wantId = String(doc.child.id_number || '').replace(/\D/g, '');
  if (wantId) {
    const byId = registrations.find(r => childIdOf(r, childByReg.get(String(r._id))) === wantId);
    if (byId) return { reg: byId, by: 'id_number' };
  }
  const wantName = normalizeChildName(doc.child.full_name);
  const wantBirth = dayKey(doc.child.birth_date);
  const byNameBirth = registrations.find(r => normalizeChildName(r.child_name) === wantName
    && dayKey(r.child_birth_date) === wantBirth);
  if (byNameBirth) return { reg: byNameBirth, by: 'name_birth' };
  return { reg: null, by: '' };
}

/**
 * POST /api/external-enrollments/import   (multipart: file, branch_id, academic_year?)
 *
 * The branch is a parameter and never a column. `מוסד` reads "כפר סבא" on every
 * row and two branches answer to that; filing a whole cohort under the wrong
 * gan is not a mistake anyone would notice quickly.
 */
async function importFile(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ error: 'לא נבחר קובץ' });
    const branchId = req.body?.branch_id;
    if (!branchId) return res.status(400).json({ error: 'יש לבחור סניף — הקובץ עצמו לא מבחין בין סניפי כפר סבא' });
    const branch = await Branch.findById(branchId).lean();
    if (!branch) return res.status(404).json({ error: 'סניף לא נמצא' });

    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = wb.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null, raw: false });
    if (!rows.length) return res.status(400).json({ error: 'הגיליון ריק' });

    const missing = missingColumns(rows[0]);
    if (missing.length) {
      return res.status(400).json({
        error: `חסרות עמודות בקובץ: ${missing.join(', ')}`,
        code: 'MISSING_COLUMNS',
        expected: Object.values(COLUMNS),
      });
    }

    const parsed = parseSheet(rows, {
      branchId,
      sourceFile: req.file.originalname || '',
    });
    if (req.body?.academic_year) {
      const forced = normalizeYear(req.body.academic_year);
      for (const d of parsed) d.academic_year = forced;
    }
    // Without a year there is nothing to scope the "which children are gone"
    // query to, and an unscoped one would mark the whole branch missing.
    if (!parsed.length || !parsed[0].academic_year) {
      return res.status(400).json({ error: 'לא נמצאו שורות עם שנת לימודים' });
    }

    // What this system already holds, for matching. Not branch-filtered: a
    // family that moved between branches is still the same child.
    const registrations = await Registration.find({}).lean();
    const children = await Child.find({}).select('registration_id child_id_number').lean();
    const childByReg = new Map(children.map(c => [String(c.registration_id), c]));

    let created = 0; let updated = 0; let unchanged = 0;
    const results = [];
    const now = new Date();
    const seen = new Set();
    const updateDetails = [];

    for (const doc of parsed) {
      const { reg, by } = matchExisting(doc, registrations, childByReg);
      doc.review = {
        status: 'pending',
        matched_registration_id: reg?._id || null,
        matched_by: by,
      };
      doc.imported_by = req.user?.id || null;
      seen.add(String(doc.child.id_number).replace(/\D/g, ''));

      const existing = await ExternalEnrollment.findOne({
        source: 'clicktac',
        academic_year: doc.academic_year,
        'child.id_number': doc.child.id_number,
      });

      if (!existing) {
        await ExternalEnrollment.create({
          ...doc,
          presence: { is_present: true, first_seen_at: now, last_seen_at: now, missing_since: null },
        });
        created += 1;
        results.push({ child: doc.child.full_name, action: 'created' });
      } else if (existing.content_hash === doc.content_hash && existing.presence?.is_present !== false) {
        existing.presence.last_seen_at = now;
        await existing.save();
        unchanged += 1;
      } else {
        // A row that changed in ClickTac. Keep the review decision already made
        // about it — the point of re-importing is the data, not to reopen a
        // question somebody answered.
        const keepReview = existing.review;
        // The placement is a decision somebody made, not data from the file.
        // A fresh export must not undo it.
        const keepPlacement = existing.placement;
        const changes = diffFields(existing.toObject(), doc);
        if (existing.presence?.is_present === false) {
          changes.push({ label: 'נוכחות בקובץ קליקטאק', from: 'הוסר/ה', to: 'חזר/ה' });
        }
        Object.assign(existing, doc, { review: keepReview, placement: keepPlacement });
        existing.presence = {
          is_present: true,
          first_seen_at: existing.presence?.first_seen_at || now,
          last_seen_at: now,
          missing_since: null,
        };
        for (const c of changes) {
          existing.changes.push({ at: now, field: c.label, from: c.from, to: c.to });
        }
        await existing.save();
        // The hash moved but nothing a person cares about did — a whitespace
        // fix in an address, or the record being rehashed after the hash
        // function was corrected. Saved either way; only counted as an update
        // when the meaning actually moved.
        if (!changes.length) { unchanged += 1; continue; }
        updated += 1;
        results.push({ child: doc.child.full_name, action: 'updated' });
        updateDetails.push({ name: doc.child.full_name, changes: changes.map(c => `${c.label}: ${c.from} ← ${c.to}`) });
      }
    }

    /**
     * Children this branch had in an earlier export and that this file no
     * longer lists. Not the same as "ביטל רישום": a cancelled family is still
     * IN the file with a status. A family that is simply gone was removed from
     * ClickTac, and the ministry may still be holding a place for them.
     */
    const gone = await ExternalEnrollment.find({
      source: 'clicktac',
      branch_id: branchId,
      academic_year: parsed[0]?.academic_year,
      'presence.is_present': { $ne: false },
    });
    const missingNames = [];
    for (const doc of gone) {
      if (seen.has(String(doc.child.id_number).replace(/\D/g, ''))) continue;
      doc.presence.is_present = false;
      doc.presence.missing_since = now;
      doc.changes.push({ at: now, field: 'נוכחות בקובץ קליקטאק', from: 'רשום/ה', to: 'הוסר/ה מהקובץ' });
      await doc.save();
      missingNames.push(doc.child.full_name);
    }

    const batch = await EnrollmentImport.create({
      source: 'clicktac',
      branch_id: branchId,
      academic_year: parsed[0]?.academic_year || '',
      file_name: req.file.originalname || '',
      sheet_name: sheetName,
      rows: rows.length,
      parsed: parsed.length,
      created,
      updated,
      unchanged,
      missing: missingNames.length,
      details: {
        created: results.filter(r => r.action === 'created').map(r => r.child).slice(0, 100),
        updated: updateDetails.slice(0, 100),
        missing: missingNames.slice(0, 100),
      },
      imported_by: req.user?.id || null,
    });

    res.json({
      branch: branch.name,
      sheet: sheetName,
      rows: rows.length,
      parsed: parsed.length,
      created,
      updated,
      unchanged,
      missing: missingNames.length,
      missing_names: missingNames.slice(0, 50),
      results: results.slice(0, 50),
      import_id: batch._id,
    });
  } catch (error) {
    next(error);
  }
}

/** GET /api/external-enrollments — the queue. Never includes bank details. */
async function list(req, res, next) {
  try {
    const filter = { ...getBranchFilter(req) };
    if (req.query.year) filter.academic_year = normalizeYear(req.query.year);
    if (req.query.status) filter['review.status'] = req.query.status;

    const docs = await ExternalEnrollment.find(filter)
      // standing_order and raw are deliberately absent: a list request is not
      // a reason to put 64 families' bank accounts on the wire.
      .select('-standing_order -raw')
      .populate('branch_id', 'name')
      .populate('review.matched_registration_id', 'child_name academic_year monthly_fee')
      .sort({ 'child.full_name': 1 })
      .lean();

    const q = String(req.query.q || '').trim().toLowerCase();
    const filtered = q
      ? docs.filter(d => d.child.full_name?.toLowerCase().includes(q)
        || String(d.child.id_number).includes(q)
        || `${d.parent1?.first_name} ${d.parent1?.last_name}`.toLowerCase().includes(q)
        || `${d.parent2?.first_name} ${d.parent2?.last_name}`.toLowerCase().includes(q))
      : docs;

    res.json({
      enrollments: filtered.map(d => ({
        ...d,
        id: d._id,
        branch_name: d.branch_id?.name || '',
        branch_id: d.branch_id?._id || d.branch_id,
      })),
      summary: {
        total: docs.length,
        pending: docs.filter(d => d.review?.status === 'pending').length,
        imported: docs.filter(d => d.review?.status === 'imported').length,
        ignored: docs.filter(d => d.review?.status === 'ignored').length,
        matched: docs.filter(d => d.review?.matched_registration_id).length,
        cancelled: docs.filter(d => d.enrollment?.status === 'ביטל רישום').length,
        disagree_age_group: docs.filter(d => d.computed?.agrees_with_source === false).length,
      },
    });
  } catch (error) {
    next(error);
  }
}

/** GET /api/external-enrollments/:id — one record, bank details included. */
async function getOne(req, res, next) {
  try {
    const doc = await ExternalEnrollment.findById(req.params.id)
      .populate('branch_id', 'name')
      .populate('review.matched_registration_id', 'child_name academic_year monthly_fee parent_name')
      .lean();
    if (!doc) return res.status(404).json({ error: 'רשומה לא נמצאה' });
    res.json({ enrollment: { ...doc, id: doc._id } });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/external-enrollments/pricing?branch=&year=
 *
 * The tuition is NOT in the export — ClickTac carries the funding type, not
 * the amount, and the subsidy tier (דרגה) that decides the price is a property
 * of the family's income that this file does not include. So the price comes
 * from the branch's own state matrix, and the tier is chosen per child at
 * import.
 *
 * The matrix columns are the state's: עד 15 חודש / 15–24 חודש / מעל 24 חודש —
 * the same two boundaries the export's own age groups fall on, which is what
 * makes the computed age group usable for picking a column.
 */
async function pricing(req, res, next) {
  try {
    const year = normalizeYear(req.query.year || enrollmentYear());
    const hebrew = hebrewYearForStart(Number(year.split('-')[0]));
    // BranchPricing stores the year in Hebrew letters, not as "YYYY-YYYY".
    const doc = await BranchPricing.findOne({
      branch_id: req.query.branch,
      $or: [{ academic_year: hebrew }, { academic_year: year }],
    }).lean();
    if (!doc) return res.json({ pricing: null, age_groups: AGE_GROUPS.map(g => g.name) });
    res.json({
      pricing: {
        pricing_type: doc.pricing_type,
        fixed_monthly_fee: doc.fixed_monthly_fee,
        age_groups: doc.age_groups,
        tiers: doc.tiers,
        addons: doc.addons,
        one_time: doc.one_time,
        installments: doc.installments,
      },
      // Which matrix column each ClickTac age group belongs to. Index-aligned
      // to `age_groups`, because the labels are the state's wording and will
      // not match the export's.
      age_group_columns: AGE_GROUPS.map((g, i) => ({ name: g.name, column: i })),
    });
  } catch (error) {
    next(error);
  }
}

/**
 * ClickTac's age layer -> this system's classroom category.
 *
 * Classroom.category is the enum that survives renaming: a branch calls its
 * rooms תינוקייה א and תינוקייה ב, and both are the same category. Matching on
 * the name would put half a cohort nowhere.
 */
const AGE_GROUP_TO_CATEGORY = {
  'תינוק': 'תינוקייה',
  'פעוט': 'צעירים',
  'בוגר': 'בוגרים',
};

/**
 * GET /api/external-enrollments/classroom-plan?branch=&year=
 *
 * How many children fall in each age group, and which classrooms exist to
 * receive them. משה דיין has no classrooms at all for תשפ״ז — importing
 * seventy-seven children into a year with no rooms puts every one of them
 * outside the classes screen, the attendance screen and the collections
 * grouping, which is a worse outcome than not importing.
 */
async function classroomPlan(req, res, next) {
  try {
    const year = normalizeYear(req.query.year || enrollmentYear());
    const branchId = req.query.branch;
    if (!branchId) return res.status(400).json({ error: 'יש לבחור סניף' });

    const pending = await ExternalEnrollment.find({
      branch_id: branchId,
      academic_year: year,
      'review.status': 'pending',
    }).select('computed.age_group child.age_group enrollment.status').lean();

    const rooms = await Classroom.find({ branch_id: branchId, academic_year: year, is_active: true })
      .select('name category capacity').lean();

    // A name with a replacement character in it is a corrupted row, not a
    // room anybody should be able to pick. Half the classrooms in the database
    // are these; offering them would file children into a name nobody can read.
    const clean = rooms.filter(r => !/�/.test(r.name));

    const groups = Object.entries(AGE_GROUP_TO_CATEGORY).map(([ageGroup, category]) => {
      const children = pending.filter(p => (p.computed?.age_group || p.child?.age_group) === ageGroup);
      return {
        age_group: ageGroup,
        category,
        count: children.length,
        active_count: children.filter(p => p.enrollment?.status !== 'ביטל רישום').length,
        classrooms: clean.filter(r => r.category === category)
          .map(r => ({ id: r._id, name: r.name, capacity: r.capacity })),
      };
    });

    res.json({
      academic_year: year,
      groups,
      // Every clean room in the year, for the cases where the category is not
      // set on an older row and the name is the only clue.
      classrooms: clean.map(r => ({ id: r._id, name: r.name, category: r.category, capacity: r.capacity })),
      garbled_classrooms: rooms.length - clean.length,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/external-enrollments/classrooms  { branch_id, academic_year, category, name, capacity }
 *
 * Creating the year's rooms from inside the import, because that is where the
 * absence is discovered and sending someone to another screen mid-import is
 * how a cohort ends up half-filed.
 */
async function createClassroom(req, res, next) {
  try {
    const { branch_id, category, name, capacity } = req.body || {};
    const academic_year = normalizeYear(req.body?.academic_year || '');
    if (!branch_id || !name || !academic_year) {
      return res.status(400).json({ error: 'חסרים סניף, שם כיתה או שנה' });
    }
    // Required, not merely validated. A room with no age group is invisible to
    // this very screen — see the note on categoryError in classroom.controller.
    if (!category) {
      return res.status(400).json({
        error: 'יש לבחור קבוצת גיל לכיתה. בלי קבוצה הכיתה לא תוצע כאן ואי אפשר יהיה לשבץ אליה.',
      });
    }
    if (!Classroom.CATEGORIES.includes(category)) {
      return res.status(400).json({ error: 'קטגוריית כיתה לא תקינה' });
    }
    const existing = await Classroom.findOne({ name, academic_year, branch_id });
    if (existing) {
      return res.status(409).json({ error: 'כיתה בשם זה כבר קיימת בסניף לשנה זו' });
    }
    const classroom = await Classroom.create({
      name, category, academic_year, branch_id,
      capacity: Number(capacity) || null,
    });
    res.status(201).json({ classroom: { ...classroom.toObject(), id: classroom._id } });
  } catch (error) {
    next(error);
  }
}

/**
 * Turn one reviewed enrollment into a real registration.
 *
 * Creates the Registration and the Child, and — when ClickTac recorded a
 * registration-fee receipt — the Collection row that already holds it, so the
 * money the family has demonstrably paid is not asked for a second time.
 *
 * The contract was signed in ClickTac. `agreement_signed` stays FALSE because
 * this system holds no signature, and `configuration.external_source` records
 * where it was signed instead — a completed registration with no signature is
 * flagged on the registrations page, and that flag would be a lie here.
 */
async function promoteOne(doc, opts) {
  const { monthly_fee, registration_fee, classroom_id, userId } = opts;

  const parentName = `${doc.parent1?.first_name || ''} ${doc.parent1?.last_name || ''}`.trim();
  const [y1, y2] = doc.academic_year.split('-').map(Number);

  const registration = await Registration.create({
    unique_id: generateUniqueId('REG'),
    branch_id: doc.branch_id,
    child_name: doc.child.full_name,
    child_birth_date: doc.child.birth_date,
    classroom_id: classroom_id || null,
    parent_name: parentName,
    parent_id_number: doc.parent1?.id_number || null,
    parent_phone: doc.parent1?.phone || null,
    parent_email: doc.parent1?.email || null,
    monthly_fee,
    registration_fee: registration_fee || 0,
    start_date: new Date(Date.UTC(y1, 8, 1)),
    end_date: new Date(Date.UTC(y2, 7, 31)),
    academic_year: doc.academic_year,
    // Enrolled, and accepted — but signed somewhere else.
    status: 'completed',
    agreement_signed: false,
    card_completed: true,
    configuration: {
      external_source: {
        system: 'clicktac',
        enrollment_id: String(doc._id),
        child_id_number: doc.child.id_number,
        status: doc.enrollment?.status || '',
        second_signer: doc.enrollment?.second_signer || '',
        continuing: !!doc.enrollment?.continuing,
        registered_at: doc.enrollment?.registered_at || null,
        receipt_number: doc.enrollment?.receipt_number || '',
        portal: doc.enrollment?.portal || '',
        age_group: doc.child.age_group,
        computed_age_group: doc.computed?.age_group,
        placed_age_group: doc.placement?.age_group_override || '',
        health_fund: doc.child.health_fund,
        gender: doc.child.gender,
        standing_order: doc.standing_order || {},
        tuition_method: doc.enrollment?.tuition_method || '',
      },
      medical_alerts: doc.child.has_allergy ? doc.child.allergy_detail : '',
    },
  });

  // Both parents, from the start. ClickTac asks for two registrants and 73 of
  // 77 rows have both — this is the one import where the second parent is not
  // something to infer later.
  const parent2Name = `${doc.parent2?.first_name || ''} ${doc.parent2?.last_name || ''}`.trim();
  await Child.create({
    registration_id: registration._id,
    child_name: doc.child.full_name,
    child_id_number: doc.child.id_number || null,
    birth_date: doc.child.birth_date,
    classroom_id: classroom_id || null,
    parent_name: parentName,
    parent_id_number: doc.parent1?.id_number || null,
    phone: doc.parent1?.phone || null,
    email: doc.parent1?.email || null,
    parent2_name: parent2Name || null,
    parent2_id_number: doc.parent2?.id_number || null,
    parent2_phone: doc.parent2?.phone || null,
    parent2_email: doc.parent2?.email || null,
    address: doc.parent1?.address || doc.parent2?.address || null,
    allergies: doc.child.has_allergy ? doc.child.allergy_detail : null,
    medical_alerts: doc.child.health_fund ? `קופת חולים: ${doc.child.health_fund}` : null,
    emergency_contact: doc.child.aide_name || null,
    emergency_phone: doc.child.aide_phone || null,
    academic_year: doc.academic_year,
    is_active: true,
  });

  // The registration fee was paid in ClickTac and has a receipt number. Filing
  // it means the collections table opens showing it paid rather than owed.
  if (doc.enrollment?.receipt_number) {
    await Collection.findOneAndUpdate(
      { registration_id: registration._id, academic_year: doc.academic_year },
      {
        $set: { registration_fee_receipt: doc.enrollment.receipt_number },
        $setOnInsert: { registration_id: registration._id, academic_year: doc.academic_year, months: [] },
      },
      { upsert: true },
    );
  }

  await ExternalEnrollment.updateOne({ _id: doc._id }, {
    $set: {
      'review.status': 'imported',
      'review.imported_registration_id': registration._id,
      'review.imported_at': new Date(),
    },
  });

  return registration;
}

/** POST /api/external-enrollments/:id/promote */
async function promote(req, res, next) {
  try {
    const doc = await ExternalEnrollment.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'רשומה לא נמצאה' });
    if (doc.review?.status === 'imported') {
      return res.status(409).json({ error: 'הרשומה כבר יובאה למערכת' });
    }
    const monthlyFee = Number(req.body?.monthly_fee);
    if (!Number.isFinite(monthlyFee) || monthlyFee <= 0) {
      return res.status(400).json({ error: 'יש לקבוע שכר לימוד — הוא לא קיים בקובץ הייצוא' });
    }
    if (doc.review?.matched_registration_id && !req.body?.allow_duplicate) {
      return res.status(409).json({
        error: `${doc.child.full_name} כבר קיים/ת במערכת`,
        code: 'ALREADY_IN_SYSTEM',
        matched_registration_id: doc.review.matched_registration_id,
      });
    }

    const registration = await promoteOne(doc, {
      monthly_fee: monthlyFee,
      registration_fee: Number(req.body?.registration_fee) || 0,
      // The room decided on the placement screen, unless this call names one.
      classroom_id: req.body?.classroom_id || doc.placement?.classroom_id || null,
      userId: req.user?.id || null,
    });

    res.status(201).json({ registration: { ...registration.toObject(), id: registration._id } });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/external-enrollments/promote-bulk  { ids, fees_by_age_group, registration_fee }
 *
 * `fees_by_age_group` rather than one fee: the state matrix prices a תינוק
 * differently from a בוגר, and a single number applied to seventy children
 * would be wrong for most of them.
 *
 * Each failure is reported with its reason instead of aborting the run — a
 * duplicate in the middle of a list should not leave half of it imported with
 * nothing saying which half.
 */
async function promoteBulk(req, res, next) {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (!ids.length) return res.status(400).json({ error: 'לא נבחרו רשומות' });
    const fees = req.body?.fees_by_age_group || {};
    const regFee = Number(req.body?.registration_fee) || 0;

    const imported = [];
    const skipped = [];
    for (const id of ids) {
      // eslint-disable-next-line no-await-in-loop
      const doc = await ExternalEnrollment.findById(id).lean();
      if (!doc) { skipped.push({ id, error: 'לא נמצאה' }); continue; }
      if (doc.review?.status === 'imported') { skipped.push({ id, child: doc.child.full_name, error: 'כבר יובאה' }); continue; }
      if (doc.review?.matched_registration_id && !req.body?.allow_duplicate) {
        skipped.push({ id, child: doc.child.full_name, error: 'כבר קיים/ת במערכת' });
        continue;
      }
      const group = effectiveAgeGroup(doc);
      const fee = Number(fees[group]);
      if (!Number.isFinite(fee) || fee <= 0) {
        skipped.push({ id, child: doc.child.full_name, error: `אין שכר לימוד לשכבה "${group}"` });
        continue;
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        const reg = await promoteOne(doc, {
          monthly_fee: fee,
          registration_fee: regFee,
          // The classroom follows the child's age group, which is the whole
          // point of computing it. One classroom for everybody would put a
          // four-month-old in with the two-year-olds.
          classroom_id: doc.placement?.classroom_id
            || (req.body?.classrooms_by_age_group || {})[group]
            || req.body?.classroom_id || null,
          userId: req.user?.id || null,
        });
        imported.push({ id, child: doc.child.full_name, registration_id: reg._id });
      } catch (e) {
        skipped.push({ id, child: doc.child.full_name, error: e.message });
      }
    }

    res.json({ imported: imported.length, skipped, details: imported });
  } catch (error) {
    next(error);
  }
}

/** PUT /api/external-enrollments/:id/review  { status, note } */
async function setReview(req, res, next) {
  try {
    const status = req.body?.status;
    if (!['pending', 'ignored'].includes(status)) {
      return res.status(400).json({ error: 'סטטוס לא תקין' });
    }
    const doc = await ExternalEnrollment.findByIdAndUpdate(
      req.params.id,
      { $set: { 'review.status': status, 'review.note': req.body?.note || '' } },
      { new: true },
    ).lean();
    if (!doc) return res.status(404).json({ error: 'רשומה לא נמצאה' });
    res.json({ enrollment: { ...doc, id: doc._id } });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/external-enrollments/:id/placement  { age_group, classroom_id, note }
 *
 * The manager's own call on which group a child joins.
 *
 * The ministry's שכבת גיל is a funding bracket and ClickTac's is whatever the
 * parent's form said; neither knows this gan. A child of 22 months may belong
 * with the בוגרים here and with the צעירים next door, and the person who runs
 * the room is the one who can say. The decision is stored separately from
 * everything parsed out of a file, so the next export cannot quietly undo it,
 * and it is what the import then uses to pick the fee column and the room.
 *
 * Sending an empty age_group clears the decision and hands the child back to
 * the computed group.
 */
async function setPlacement(req, res, next) {
  try {
    const group = String(req.body?.age_group || '').trim();
    const valid = AGE_GROUPS.map(g => g.name);
    if (group && !valid.includes(group)) {
      return res.status(400).json({ error: `שכבת גיל לא תקינה. אפשרויות: ${valid.join(', ')}` });
    }

    const doc = await ExternalEnrollment.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'רשומה לא נמצאה' });
    if (doc.review?.status === 'imported') {
      return res.status(409).json({
        error: `${doc.child.full_name} כבר נקלט/ה למערכת — שיבוץ הכיתה משתנה במסך הכיתות`,
        code: 'ALREADY_IMPORTED',
      });
    }

    let classroomId = req.body?.classroom_id || null;
    if (classroomId) {
      const room = await Classroom.findById(classroomId).lean();
      if (!room) return res.status(404).json({ error: 'כיתה לא נמצאה' });
      if (String(room.branch_id) !== String(doc.branch_id)) {
        return res.status(400).json({ error: 'הכיתה שייכת לסניף אחר' });
      }
      if (room.academic_year && normalizeYear(room.academic_year) !== doc.academic_year) {
        return res.status(400).json({ error: 'הכיתה שייכת לשנת לימודים אחרת' });
      }
    }
    // Clearing the group with no room named clears the whole decision.
    if (!group && !classroomId) classroomId = null;

    doc.placement = {
      age_group_override: group,
      classroom_id: classroomId,
      decided_by: req.user?.id || null,
      decided_at: group || classroomId ? new Date() : null,
      note: String(req.body?.note || ''),
    };
    await doc.save();

    res.json({
      enrollment: {
        id: doc._id,
        child_name: doc.child.full_name,
        placement: doc.placement,
        effective_age_group: effectiveAgeGroup(doc.toObject()),
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * DELETE /api/external-enrollments/data?branch=&year=   — undo a whole upload.
 *
 * A file put against the wrong branch files a whole cohort in the wrong gan,
 * and there is no way to un-see that row by row. So the unit of undo is the
 * unit of the mistake: every ClickTac record for one branch and one year, and
 * the upload history with it, deleted together and re-uploaded clean.
 *
 * Rows already turned into registrations are the one thing this refuses to
 * touch. Those created a Registration, a Child and possibly a paid collection
 * row; deleting the enrollment behind them would leave the registration
 * standing with nothing to explain where it came from. They are listed by
 * name instead, so whoever is undoing knows exactly what is in the way.
 */
async function deleteData(req, res, next) {
  try {
    const branchId = req.query.branch;
    if (!branchId || branchId === 'all') return res.status(400).json({ error: 'יש לבחור סניף' });
    const academicYear = normalizeYear(req.query.year || '');
    if (!/^\d{4}-\d{4}$/.test(academicYear)) return res.status(400).json({ error: 'יש לבחור שנת לימודים' });

    const filter = { source: 'clicktac', branch_id: branchId, academic_year: academicYear };
    const imported = await ExternalEnrollment.find({ ...filter, 'review.status': 'imported' })
      .select('child.full_name review.imported_registration_id').lean();

    if (imported.length && req.query.force !== 'true') {
      return res.status(409).json({
        error: `${imported.length} רשומות כבר נקלטו למערכת כרישום ולא ניתן למחוק אותן מכאן`,
        code: 'HAS_IMPORTED',
        imported: imported.map(d => d.child?.full_name).filter(Boolean),
      });
    }

    // With force, the ones already promoted stay — only the untouched go.
    const toDelete = imported.length
      ? { ...filter, 'review.status': { $ne: 'imported' } }
      : filter;
    const { deletedCount } = await ExternalEnrollment.deleteMany(toDelete);
    const batches = await EnrollmentImport.deleteMany({
      source: 'clicktac', branch_id: branchId, academic_year: academicYear,
    });

    res.json({
      deleted: deletedCount,
      kept_imported: imported.length,
      batches_deleted: batches.deletedCount,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/external-enrollments/contacts?branch=&year=
 *
 * The parent contact sheet — the thing that could not be built at all from the
 * previous export, which carried no parent data of any kind. One row per
 * child, both parents, phones and emails, with the relation (אם / אב) so it is
 * clear who is who.
 */
async function contacts(req, res, next) {
  try {
    const filter = { ...getBranchFilter(req) };
    if (req.query.year) filter.academic_year = normalizeYear(req.query.year);
    if (req.query.status) filter['review.status'] = req.query.status;

    const docs = await ExternalEnrollment.find(filter)
      .select('child parent1 parent2 academic_year enrollment.status computed')
      .sort({ 'child.full_name': 1 })
      .lean();

    res.json({
      contacts: docs.map(d => ({
        child_name: d.child.full_name,
        child_id_number: d.child.id_number,
        birth_date: d.child.birth_date,
        age_group: d.computed?.age_group || d.child.age_group,
        status: d.enrollment?.status || '',
        parent1_name: `${d.parent1?.first_name || ''} ${d.parent1?.last_name || ''}`.trim(),
        parent1_relation: d.parent1?.relation || '',
        parent1_phone: d.parent1?.phone || '',
        parent1_email: d.parent1?.email || '',
        parent2_name: `${d.parent2?.first_name || ''} ${d.parent2?.last_name || ''}`.trim(),
        parent2_relation: d.parent2?.relation || '',
        parent2_phone: d.parent2?.phone || '',
        parent2_email: d.parent2?.email || '',
        address: d.parent1?.address || d.parent2?.address || '',
      })),
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  importFile, list, getOne, pricing, promote, promoteBulk, setReview, contacts,
  classroomPlan, createClassroom, setPlacement, deleteData, effectiveAgeGroup,
  // Used by the placement board's confirm step, which is the same act of
  // creating a registration seen from the other end.
  promoteOne,
};
