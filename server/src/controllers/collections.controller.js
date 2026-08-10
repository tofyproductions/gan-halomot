const { Registration, Classroom, Child, Collection, CollectionHistory, PriceAdjustment, Discount, SummerCamp, Branch } = require('../models');
const {
  normalizeYear, getAcademicYears, academicYearOf,
  ACADEMIC_MONTHS, CAMP_MONTH,
} = require('../services/academic-year.service');
const { calculatePaymentStatus } = require('../services/prorate.service');
const { buildHouseholds } = require('../services/household.service');
const { getBranchFilter } = require('../utils/branch-filter');

async function getAll(req, res, next) {
  try {
    const { year } = req.query;
    const academicYears = getAcademicYears();
    const targetYear = year ? normalizeYear(year) : academicYears.current.range;

    const branchFilter = getBranchFilter(req);

    // Include all registrations that have active children (not just status=completed)
    const activeChildren = await Child.find({ is_active: true }).select('registration_id').lean();
    const activeRegIds = activeChildren.map(c => c.registration_id);

    const registrations = await Registration.find({
      ...branchFilter,
      $or: [
        { status: 'completed' },
        { _id: { $in: activeRegIds } },
      ],
    })
      .populate('classroom_id', 'name')
      .sort({ child_name: 1 })
      .lean();

    // A registration belongs to the year it is FILED under — one year, the one
    // its contract was signed against. This used to be a date-range OVERLAP,
    // which is a different question: a registration running January 2026 to
    // August 2027 overlaps two gan years, so it was listed in both, twice
    // demanding a full year of payments from the same family. Overlap also
    // could not be corrected — the year was a consequence of the dates rather
    // than something anyone could set.
    const filteredRegs = registrations.filter(r => academicYearOf(r) === targetYear);

    // Get children for these registrations
    const regIds = filteredRegs.map(r => r._id);
    const children = await Child.find({ registration_id: { $in: regIds }, is_active: true }).lean();
    const childByReg = {};
    for (const c of children) {
      childByReg[String(c.registration_id)] = c;
    }

    // Get collections
    const collections = await Collection.find({
      registration_id: { $in: regIds },
      academic_year: targetYear,
    }).lean();

    const collectionByReg = {};
    for (const c of collections) {
      collectionByReg[String(c.registration_id)] = c;
    }

    // Load discounts for this branch
    const allDiscounts = await Discount.find({ is_active: true, ...getBranchFilter(req) }).lean();

    // Summer-camp config, keyed by branch. Only the branches that run one this
    // year get a camp cell — for everyone else the column simply isn't there.
    const campByBranch = new Map(
      (await SummerCamp.find({
        academic_year: targetYear,
        enabled: true,
        branch_id: { $in: [...new Set(filteredRegs.map(r => String(r.branch_id)).filter(Boolean))] },
      }).lean()).map(c => [String(c.branch_id), c]),
    );

    /**
     * The camp cell for one child, or null when her branch has no camp.
     *
     * The charge is flat — never prorated like a monthly fee — because the camp
     * is a fixed-price product, not a month of care. Only a child who left the
     * gan mid-year is skipped by default, and even she stays editable.
     */
    function buildCampCell(reg, existing) {
      const camp = campByBranch.get(String(reg.branch_id));
      if (!camp) return null;

      // Deliberately NOT gated on the camp dates falling inside the child's
      // registration. The school year runs Sept–July and the camp is in August,
      // *after* it — so comparing the two excluded every child in the branch,
      // which is exactly what happened: the whole column showed ₪0 and no cell
      // could be opened. What actually decides is whether she left early, and
      // the exit month already records that.
      const exitM = collectionByReg[String(reg._id)]?.exit_month ?? null;
      const leftEarly = exitM != null && exitM !== 7 && exitM !== 8;

      // Attendance is per child. Two siblings, one camp — see
      // Collection.camp_enrolled for why this is three-state.
      const enrolled = collectionByReg[String(reg._id)]?.camp_enrolled ?? null;

      const hasOverride = existing.fee_override != null;
      const base = camp.amount || 0;
      const expected = hasOverride
        ? existing.fee_override
        : (leftEarly || enrolled === false ? 0 : base);

      let receiptNumber = existing.receipt_number || null;
      // A camp receipt only travels between siblings who are BOTH in the camp.
      // This is the line that marked a child as paid for a camp they never
      // attended, and it could not be undone because nothing was stored.
      if (!receiptNumber && enrolled === true) receiptNumber = findSiblingMonthReceipt(reg, CAMP_MONTH);
      let paymentStatus = existing.payment_status || 'expected';
      if (receiptNumber) paymentStatus = 'paid';
      else if (enrolled === false) paymentStatus = 'exempt';

      return {
        month: CAMP_MONTH,
        label: camp.label || 'קייטנה',
        camp_enrolled: enrolled,
        expected_amount: expected,
        paid_amount: paymentStatus === 'paid' ? expected : (parseFloat(existing.paid_amount) || 0),
        discount_amount: 0,
        receipt_number: receiptNumber,
        payment_status: paymentStatus,
        payment_date: existing.payment_date || null,
        is_prorated: false,
        // Never greyed out. A greyed cell is a cell the table refuses to open,
        // and a receipt has to be enterable for any child — including one who
        // left in March and came back just for the camp.
        is_before_start: false,
        left_early: !!leftEarly,
        notes: existing.notes || null,
        has_fee_override: hasOverride,
        fee_override_reason: existing.fee_override_reason || null,
        original_expected: hasOverride ? (leftEarly ? 0 : base) : null,
      };
    }

    // Build sibling map: household -> [reg, reg, ...]
    //
    // Keyed by household rather than by the parent who happened to sign. A
    // child has two parents, and each registration carries only one of them —
    // different name, different ID, different phone — so grouping on the
    // parent puts one family's children in two groups and hides a receipt paid
    // by the other parent. The households are joined by the children they
    // share, across every registration in the system rather than only this
    // year's, because that is where the two parents show up separately.
    const householdOf = buildHouseholds(registrations);
    const siblingMap = {};
    for (const reg of filteredRegs) {
      const key = householdOf(reg);
      if (!key) continue;
      if (!siblingMap[key]) siblingMap[key] = [];
      siblingMap[key].push(reg);
    }

    // Helper: find sibling's reg fee receipt if current child doesn't have one
    function findSiblingRegFee(reg) {
      const key = householdOf(reg);
      if (!key) return null;
      const siblings = siblingMap[key] || [];
      for (const sib of siblings) {
        if (String(sib._id) === String(reg._id)) continue;
        const sibColl = collectionByReg[String(sib._id)];
        if (sibColl?.registration_fee_receipt) {
          return '-' + sibColl.registration_fee_receipt;
        }
      }
      return null;
    }

    // Helper: find sibling's monthly receipt for shared payments
    function findSiblingMonthReceipt(reg, monthNum) {
      const key = householdOf(reg);
      if (!key) return null;
      const siblings = siblingMap[key] || [];
      for (const sib of siblings) {
        if (String(sib._id) === String(reg._id)) continue;
        const sibColl = collectionByReg[String(sib._id)];
        const sibMonth = sibColl?.months?.find(m => m.month_number === monthNum);
        if (sibMonth?.receipt_number && !String(sibMonth.receipt_number).startsWith('-')) {
          return '-' + sibMonth.receipt_number;
        }
      }
      return null;
    }

    // Helper: calculate discount for a registration+month
    function calcDiscount(regId, classroomId, monthNum, baseFee) {
      let totalDiscount = 0;
      for (const d of allDiscounts) {
        // Check month match
        if (d.month && d.month !== monthNum) continue;

        // Check scope match
        if (d.scope === 'child' && String(d.registration_id) !== String(regId)) continue;
        if (d.scope === 'classroom' && String(d.classroom_id) !== String(classroomId)) continue;
        // scope === 'branch' matches all

        if (d.discount_type === 'percentage') {
          totalDiscount += baseFee * (d.value / 100);
        } else {
          totalDiscount += d.value;
        }
      }
      return Math.round(totalDiscount);
    }

    // Build grouped result
    const grouped = {};
    for (const reg of filteredRegs) {
      const groupName = reg.classroom_id?.name || 'ללא קבוצה';
      if (!grouped[groupName]) grouped[groupName] = [];

      const collection = collectionByReg[String(reg._id)] || null;
      const monthsMap = {};
      if (collection) {
        for (const m of (collection.months || [])) {
          monthsMap[m.month_number] = m;
        }
      }

      const fee = parseFloat(reg.monthly_fee) || 0;
      const classroomObjId = reg.classroom_id?._id || reg.classroom_id;
      const endDate = collection?.exit_month
        ? (() => {
            const exitM = collection.exit_month;
            const exitY = exitM >= 9 ? y1 : y2;
            return new Date(exitY, exitM - 1, new Date(exitY, exitM, 0).getDate());
          })()
        : null;

      // Parse fee_effective_from (YYYY-MM) into academic month number
      let priceChangeMonth = null;
      let oldFee = null;
      if (reg.fee_effective_from && reg.previous_monthly_fee != null) {
        const [, effMonth] = reg.fee_effective_from.split('-').map(Number);
        if (effMonth >= 1 && effMonth <= 12) {
          priceChangeMonth = effMonth;
          oldFee = reg.previous_monthly_fee;
        }
      }

      const { expectedFees, isBeforeStart } = calculatePaymentStatus(
        oldFee != null ? oldFee : fee,
        reg.start_date,
        targetYear,
        endDate ? endDate.toISOString().split('T')[0] : reg.end_date,
        priceChangeMonth,
        priceChangeMonth ? fee : undefined
      );

      const child = childByReg[String(reg._id)];

      // Detect registration fee receipts: use stored value or check sibling
      let detectedRegFeeReceipt = collection?.registration_fee_receipt || null;
      if (!detectedRegFeeReceipt) {
        detectedRegFeeReceipt = findSiblingRegFee(reg);
      }

      const monthData = ACADEMIC_MONTHS.map(m => {
        const existing = monthsMap[m] || {};
        let expected = expectedFees[m] || 0;

        // Apply discounts
        const discount = expected > 0 ? calcDiscount(reg._id, classroomObjId, m, expected) : 0;
        expected = Math.max(0, expected - discount);

        // Apply per-child-per-month fee override
        const hasFeeOverride = existing.fee_override != null;
        const originalExpected = hasFeeOverride ? expected : null;
        if (hasFeeOverride) {
          expected = existing.fee_override;
        }

        // Get receipt - use existing, or check if it's a negative sibling receipt
        let receiptNumber = existing.receipt_number || null;
        let paymentStatus = existing.payment_status || (isBeforeStart[m] ? 'pending' : 'expected');

        // If has receipt (even negative = sibling shared), mark as paid
        if (receiptNumber) {
          paymentStatus = 'paid';
        }

        const paid = paymentStatus === 'paid' ? expected : (parseFloat(existing.paid_amount) || 0);
        return {
          month: m,
          expected_amount: expected,
          paid_amount: paid,
          discount_amount: discount,
          receipt_number: receiptNumber,
          payment_status: paymentStatus,
          payment_date: existing.payment_date || null,
          is_prorated: existing.is_prorated || false,
          is_before_start: isBeforeStart[m] || false,
          notes: existing.notes || null,
          has_fee_override: hasFeeOverride,
          fee_override_reason: existing.fee_override_reason || null,
          original_expected: originalExpected,
        };
      });

      grouped[groupName].push({
        registration_id: reg._id,
        unique_id: reg.unique_id,
        child_name: reg.child_name,
        child_id: child?._id || null,
        parent_name: reg.parent_name,
        monthly_fee: fee,
        start_date: reg.start_date,
        end_date: reg.end_date,
        collection_id: collection?._id || null,
        exit_month: collection?.exit_month || null,
        registration_fee: reg.registration_fee || 0,
        registration_fee_receipt: detectedRegFeeReceipt || null,
        months: monthData,
        camp: buildCampCell(reg, monthsMap[CAMP_MONTH] || {}),
      });
    }

    // One camp label/date range for the header. With several branches in view
    // the label is only shown when they agree; the per-child amounts are always
    // each branch's own.
    const camps = [...campByBranch.values()];
    const summerCamp = camps.length ? {
      label: [...new Set(camps.map(c => c.label || 'קייטנה'))].length === 1
        ? (camps[0].label || 'קייטנה') : 'קייטנה',
      start_date: camps.length === 1 ? camps[0].start_date : null,
      end_date: camps.length === 1 ? camps[0].end_date : null,
      branch_count: camps.length,
    } : null;

    res.json({ collections: grouped, academicYear: targetYear, summer_camp: summerCamp });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/collections/summer-camp?year=
 * The camp setup for every branch the user can see — including branches with
 * no camp, returned as a disabled row, so the dialog is a complete picture of
 * "which of my branches runs one" rather than a list of the ones already set.
 */
async function getSummerCamps(req, res, next) {
  try {
    const targetYear = req.query.year ? normalizeYear(req.query.year) : getAcademicYears().current.range;
    const branchFilter = getBranchFilter(req, '_id');
    const branches = await Branch.find({ is_active: true, ...branchFilter }).select('name').sort({ name: 1 }).lean();
    const existing = new Map(
      (await SummerCamp.find({ academic_year: targetYear }).lean()).map(c => [String(c.branch_id), c]),
    );
    res.json({
      academic_year: targetYear,
      camps: branches.map(b => {
        const c = existing.get(String(b._id));
        return {
          branch_id: String(b._id),
          branch_name: b.name,
          enabled: c?.enabled ?? false,
          label: c?.label || 'קייטנה',
          start_date: c?.start_date || null,
          end_date: c?.end_date || null,
          amount: c?.amount || 0,
          notes: c?.notes || '',
        };
      }),
    });
  } catch (error) { next(error); }
}

/**
 * PUT /api/collections/summer-camp  { branch_id, year, enabled, label, start_date, end_date, amount, notes }
 * Upsert one branch's camp. Turning it off leaves the row (and any receipts
 * already recorded against the camp) intact — the column just stops showing,
 * so switching it back on doesn't lose what was collected.
 */
async function upsertSummerCamp(req, res, next) {
  try {
    const { branch_id, year, enabled, label, start_date, end_date, amount, notes } = req.body || {};
    if (!branch_id) return res.status(400).json({ error: 'branch_id נדרש' });
    const targetYear = year ? normalizeYear(year) : getAcademicYears().current.range;

    const start = start_date ? new Date(start_date) : null;
    const end = end_date ? new Date(end_date) : null;
    if (start && end && end < start) {
      return res.status(400).json({ error: 'תאריך הסיום מוקדם מתאריך ההתחלה' });
    }
    const amountNum = amount === '' || amount == null ? 0 : Number(amount);
    if (!Number.isFinite(amountNum) || amountNum < 0) {
      return res.status(400).json({ error: 'סכום לא תקין' });
    }

    const camp = await SummerCamp.findOneAndUpdate(
      { branch_id, academic_year: targetYear },
      {
        $set: {
          enabled: enabled !== false,
          label: (label || '').trim() || 'קייטנה',
          start_date: start,
          end_date: end,
          amount: amountNum,
          notes: notes || '',
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    res.json({ camp });
  } catch (error) { next(error); }
}

async function getByRegistration(req, res, next) {
  try {
    const { registrationId } = req.params;
    const registration = await Registration.findById(registrationId)
      .populate('classroom_id', 'name').lean();
    if (!registration) {
      return res.status(404).json({ error: 'Registration not found' });
    }
    registration.id = registration._id;
    registration.classroom_name = registration.classroom_id?.name || null;

    const collection = await Collection.findOne({ registration_id: registrationId }).lean();
    res.json({ registration, collection, months: collection?.months || [] });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/collections/:registrationId/camp-enrollment   { enrolled: true|false|null }
 *
 * Mark whether this child is in the camp. Setting it to false also clears the
 * camp cell: a child who is not attending should not be left holding a receipt
 * or a paid amount from when everyone assumed they were.
 */
async function updateCampEnrollment(req, res, next) {
  try {
    const { registrationId } = req.params;
    const raw = req.body?.enrolled;
    const enrolled = raw === true || raw === 'true' ? true
      : raw === false || raw === 'false' ? false
        : null;

    const registration = await Registration.findById(registrationId).lean();
    if (!registration) return res.status(404).json({ error: 'Registration not found' });

    const year = req.body?.academic_year
      ? normalizeYear(req.body.academic_year)
      : getAcademicYears().current.range;
    const collection = await Collection.findOne({ registration_id: registrationId, academic_year: year })
      || new Collection({ registration_id: registrationId, child_id: registration.child_id || null, academic_year: year, months: [] });

    collection.camp_enrolled = enrolled;

    if (enrolled === false) {
      const cell = (collection.months || []).find(m => m.month_number === CAMP_MONTH);
      if (cell) {
        cell.receipt_number = null;
        cell.paid_amount = 0;
        cell.payment_status = 'exempt';
        cell.payment_date = null;
      }
    }
    collection.last_updated = new Date();
    await collection.save();

    res.json({ ok: true, camp_enrolled: collection.camp_enrolled });
  } catch (error) { next(error); }
}

/**
 * PUT /api/collections/camp-enrollment/bulk   { enrolled, branch_id?, academic_year? }
 *
 * Mark every child in scope at once.
 *
 * Most children are not in the camp — it is an opt-in product — so marking
 * them one at a time is the wrong shape of work. Setting the whole branch to
 * "not attending" and then flipping the handful who signed up is a dozen
 * clicks instead of eighty.
 *
 * Children already marked are NOT touched: a bulk sweep must not undo an
 * answer somebody already gave.
 */
async function bulkCampEnrollment(req, res, next) {
  try {
    const raw = req.body?.enrolled;
    const enrolled = raw === true || raw === 'true' ? true
      : raw === false || raw === 'false' ? false
        : null;
    const year = req.body?.academic_year ? normalizeYear(req.body.academic_year) : getAcademicYears().current.range;
    const onlyUnmarked = req.body?.only_unmarked !== false;

    const regFilter = { ...getBranchFilter(req) };
    if (req.body?.branch_id) regFilter.branch_id = req.body.branch_id;
    const regs = await Registration.find(regFilter).select('_id child_id').lean();
    if (regs.length === 0) return res.json({ ok: true, updated: 0 });

    const regIds = regs.map(r => r._id);
    const existing = await Collection.find({ registration_id: { $in: regIds }, academic_year: year })
      .select('registration_id camp_enrolled').lean();
    const byReg = new Map(existing.map(c => [String(c.registration_id), c]));

    let updated = 0;
    for (const reg of regs) {
      const current = byReg.get(String(reg._id));
      if (onlyUnmarked && current && current.camp_enrolled !== null && current.camp_enrolled !== undefined) continue;

      await Collection.findOneAndUpdate(
        { registration_id: reg._id, academic_year: year },
        {
          $set: { camp_enrolled: enrolled, last_updated: new Date() },
          $setOnInsert: { child_id: reg.child_id || null, months: [] },
        },
        { upsert: true },
      );
      updated += 1;
    }

    res.json({ ok: true, updated, skipped: regs.length - updated });
  } catch (error) { next(error); }
}

async function updateMonth(req, res, next) {
  try {
    const { registrationId, monthIndex } = req.params;
    const { receipt_number, paid_amount, payment_status, notes, force, fee_override, fee_override_reason } = req.body;
    const monthNum = parseInt(monthIndex);

    // 13 = קייטנה. It stores exactly like a month, so nothing below it changes.
    if (isNaN(monthNum) || monthNum < 1 || monthNum > CAMP_MONTH) {
      return res.status(400).json({ error: `Invalid month index (1-${CAMP_MONTH})` });
    }

    const registration = await Registration.findById(registrationId);
    if (!registration) {
      return res.status(404).json({ error: 'Registration not found' });
    }

    // Parse receipt number(s) - support multiple receipts separated by space/comma/slash/paren
    function splitReceipts(str) {
      if (!str) return [];
      return String(str).split(/[\s,/)]+/).map(s => s.trim()).filter(Boolean);
    }
    function receiptsMatch(cellValue, searchValue) {
      const cellNums = splitReceipts(cellValue);
      const searchNums = splitReceipts(searchValue);
      return searchNums.some(s => cellNums.some(c => c === s || c === '-' + s || '-' + c === s));
    }

    // Smart duplicate receipt number validation
    let isDuplicateOverride = false;
    if (receipt_number) {
      // Find ALL collections - we need to check each manually for multi-receipt cells
      const allCollections = await Collection.find({})
        .populate('registration_id', 'child_name parent_name parent_id_number parent_phone')
        .lean();

      const searchNums = splitReceipts(receipt_number);
      const duplicateCollections = allCollections.filter(c =>
        (c.months || []).some(m => m.receipt_number && receiptsMatch(m.receipt_number, receipt_number))
      );

      const duplicates = [];
      const MONTH_NAMES = { 9: 'ספט׳', 10: 'אוק׳', 11: 'נוב׳', 12: 'דצמ׳', 1: 'ינו׳', 2: 'פבר׳', 3: 'מרץ', 4: 'אפר׳', 5: 'מאי', 6: 'יוני', 7: 'יולי', 8: 'אוג׳', [CAMP_MONTH]: 'קייטנה' };

      for (const dc of duplicateCollections) {
        // Skip if it's the same registration + same month (editing own receipt)
        if (String(dc.registration_id?._id) === String(registrationId)) {
          const ownMonth = dc.months.find(m => m.month_number === monthNum && receiptsMatch(m.receipt_number, receipt_number));
          if (ownMonth) continue;
        }

        const dupReg = dc.registration_id;
        if (!dupReg) continue;

        // Find which months have matching receipt
        const dupMonths = dc.months.filter(m => m.receipt_number && receiptsMatch(m.receipt_number, receipt_number));

        for (const dm of dupMonths) {
          // Check if same parent
          const sameParent = (
            (registration.parent_id_number && dupReg.parent_id_number &&
              registration.parent_id_number === dupReg.parent_id_number) ||
            (registration.parent_name && dupReg.parent_name &&
              registration.parent_name === dupReg.parent_name) ||
            (registration.parent_phone && dupReg.parent_phone &&
              registration.parent_phone === dupReg.parent_phone)
          );

          // Same parent + same month = silently allow (one receipt for multiple kids)
          if (sameParent && dm.month_number === monthNum) {
            continue;
          }

          duplicates.push({
            child_name: dupReg.child_name,
            parent_name: dupReg.parent_name,
            month: dm.month_number,
            month_name: MONTH_NAMES[dm.month_number] || String(dm.month_number),
            same_parent: sameParent,
          });
        }
      }

      if (duplicates.length > 0 && !force) {
        return res.status(409).json({
          error: 'duplicate_receipt',
          duplicates,
          message: `מספר קבלה ${receipt_number} כבר קיים`,
        });
      }

      if (duplicates.length > 0 && force) {
        isDuplicateOverride = true;
      }
    }

    const academicYear = academicYearOf(registration)
      || getAcademicYears().current.range;

    const child = await Child.findOne({ registration_id: registrationId, is_active: true });

    let collection = await Collection.findOne({
      registration_id: registrationId,
      academic_year: academicYear,
    });

    if (!collection) {
      collection = await Collection.create({
        registration_id: registrationId,
        child_id: child?._id || null,
        academic_year: academicYear,
        months: [],
      });
    }

    const existingIdx = collection.months.findIndex(m => m.month_number === monthNum);
    const existing = existingIdx >= 0 ? collection.months[existingIdx] : null;

    const effectiveNotes = isDuplicateOverride
      ? 'duplicate_override'
      : (notes !== undefined ? notes : (existing?.notes || null));

    const monthData = {
      month_number: monthNum,
      paid_amount: paid_amount !== undefined ? paid_amount : (existing?.paid_amount || 0),
      receipt_number: receipt_number !== undefined ? receipt_number : (existing?.receipt_number || null),
      payment_status: payment_status || (receipt_number ? 'paid' : (existing?.payment_status || 'expected')),
      payment_date: receipt_number ? new Date() : (existing?.payment_date || null),
      notes: effectiveNotes,
      fee_override: fee_override !== undefined ? fee_override : (existing?.fee_override || null),
      fee_override_reason: fee_override_reason !== undefined ? fee_override_reason : (existing?.fee_override_reason || null),
    };

    if (existingIdx >= 0) {
      collection.months[existingIdx] = { ...collection.months[existingIdx].toObject(), ...monthData };
    } else {
      collection.months.push(monthData);
    }

    collection.last_updated = new Date();
    await collection.save();

    res.json({ message: 'Month updated successfully' });
  } catch (error) {
    next(error);
  }
}

async function updateExitMonth(req, res, next) {
  try {
    const { registrationId } = req.params;
    const { exit_month } = req.body;

    const collection = await Collection.findOne({ registration_id: registrationId });
    if (!collection) {
      return res.status(404).json({ error: 'Collection not found for this registration' });
    }

    collection.exit_month = exit_month || null;
    collection.last_updated = new Date();
    await collection.save();

    res.json({ message: 'Exit month updated', exit_month });
  } catch (error) {
    next(error);
  }
}

async function updateRegistrationFee(req, res, next) {
  try {
    const { registrationId } = req.params;
    const { receipt_number, year } = req.body;

    const registration = await Registration.findById(registrationId);
    if (!registration) {
      return res.status(404).json({ error: 'Registration not found' });
    }

    const academicYear = year
      || academicYearOf(registration)
      || getAcademicYears().current.range;

    const child = await Child.findOne({ registration_id: registrationId, is_active: true });

    let collection = await Collection.findOne({
      registration_id: registrationId,
      academic_year: academicYear,
    });

    if (!collection) {
      collection = await Collection.create({
        registration_id: registrationId,
        child_id: child?._id || null,
        academic_year: academicYear,
        months: [],
      });
    }

    const trimmed = (receipt_number || '').toString().trim();
    collection.registration_fee_receipt = trimmed || null;
    collection.last_updated = new Date();
    await collection.save();

    res.json({
      message: 'Registration fee receipt updated',
      registration_fee_receipt: collection.registration_fee_receipt,
    });
  } catch (error) {
    next(error);
  }
}

async function recalculate(req, res, next) {
  try {
    const { registrationId } = req.params;
    const registration = await Registration.findById(registrationId);
    if (!registration) {
      return res.status(404).json({ error: 'Registration not found' });
    }

    const collection = await Collection.findOne({ registration_id: registrationId });
    if (!collection) {
      return res.status(404).json({ error: 'No collection record found' });
    }

    const fee = parseFloat(registration.monthly_fee) || 0;
    const academicYear = collection.academic_year;
    const [y1, y2] = academicYear.split('-').map(Number);

    let endDate = registration.end_date;
    if (collection.exit_month) {
      const exitM = collection.exit_month;
      const exitY = exitM >= 9 ? y1 : y2;
      endDate = new Date(exitY, exitM, 0).toISOString().split('T')[0];
    }

    const priceAdj = await PriceAdjustment.findOne({ registration_id: registrationId })
      .sort({ effective_month: 1 });

    const { expectedFees, isBeforeStart } = calculatePaymentStatus(
      fee,
      registration.start_date,
      academicYear,
      endDate,
      priceAdj?.effective_month || null,
      priceAdj?.new_monthly_fee || null
    );

    // Update or create month entries
    for (const m of ACADEMIC_MONTHS) {
      const existingIdx = collection.months.findIndex(cm => cm.month_number === m);
      if (existingIdx >= 0) {
        collection.months[existingIdx].expected_amount = expectedFees[m] || 0;
      } else {
        collection.months.push({
          month_number: m,
          expected_amount: expectedFees[m] || 0,
          payment_status: isBeforeStart[m] ? 'pending' : 'expected',
        });
      }
    }

    collection.last_updated = new Date();
    await collection.save();

    res.json({ message: 'Fees recalculated', expectedFees });
  } catch (error) {
    next(error);
  }
}

async function getHistory(req, res, next) {
  try {
    const history = await CollectionHistory.find().sort({ archived_at: -1 }).lean();

    const grouped = {};
    for (const entry of history) {
      const dateKey = new Date(entry.archived_at).toLocaleDateString('he-IL');
      if (!grouped[dateKey]) grouped[dateKey] = [];
      grouped[dateKey].push({
        id: entry._id,
        child_name: entry.child_name,
        academic_year: entry.academic_year,
        collection_data: entry.collection_data,
        archived_at: entry.archived_at,
      });
    }

    res.json({ history: grouped });
  } catch (error) {
    next(error);
  }
}

async function backup(req, res, next) {
  try {
    const collections = await Collection.find()
      .populate({
        path: 'registration_id',
        select: 'child_name parent_name monthly_fee',
      })
      .lean();

    if (collections.length === 0) {
      return res.status(400).json({ error: 'No collections data to backup' });
    }

    const inserts = collections.map(col => ({
      child_name: col.registration_id?.child_name || 'unknown',
      academic_year: col.academic_year,
      collection_data: col,
    }));

    await CollectionHistory.insertMany(inserts);

    res.json({ message: 'Collections backed up successfully', count: inserts.length });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getAll, getByRegistration, updateMonth, updateExitMonth,
  updateRegistrationFee, recalculate, getHistory, backup,
  getSummerCamps, upsertSummerCamp, updateCampEnrollment, bulkCampEnrollment,
};
