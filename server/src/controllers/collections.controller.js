const { Registration, Classroom, Child, Collection, CollectionHistory, PriceAdjustment, Discount } = require('../models');
const { normalizeYear, getAcademicYears, getAcademicYearStr, ACADEMIC_MONTHS } = require('../services/academic-year.service');
const { calculatePaymentStatus } = require('../services/prorate.service');
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

    const [y1, y2] = targetYear.split('-').map(Number);

    const filteredRegs = registrations.filter(r => {
      if (!r.start_date) return false;
      const startDate = new Date(r.start_date);
      const acadEnd = new Date(y2, 7, 31);
      return startDate <= acadEnd;
    });

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

    // Build sibling map: parent_id_number -> [reg_id, reg_id, ...]
    const siblingMap = {};
    for (const reg of filteredRegs) {
      const key = reg.parent_id_number?.trim() || reg.parent_name?.trim() || reg.parent_phone?.trim();
      if (!key) continue;
      if (!siblingMap[key]) siblingMap[key] = [];
      siblingMap[key].push(reg);
    }

    // Helper: find sibling's reg fee receipt if current child doesn't have one
    function findSiblingRegFee(reg) {
      const key = reg.parent_id_number?.trim() || reg.parent_name?.trim() || reg.parent_phone?.trim();
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
      const key = reg.parent_id_number?.trim() || reg.parent_name?.trim() || reg.parent_phone?.trim();
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

      const { expectedFees, isBeforeStart } = calculatePaymentStatus(
        fee,
        reg.start_date,
        targetYear,
        endDate ? endDate.toISOString().split('T')[0] : reg.end_date
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
      });
    }

    res.json({ collections: grouped, academicYear: targetYear });
  } catch (error) {
    next(error);
  }
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

async function updateMonth(req, res, next) {
  try {
    const { registrationId, monthIndex } = req.params;
    const { receipt_number, paid_amount, payment_status, notes, force, fee_override, fee_override_reason } = req.body;
    const monthNum = parseInt(monthIndex);

    if (isNaN(monthNum) || monthNum < 1 || monthNum > 12) {
      return res.status(400).json({ error: 'Invalid month index (1-12)' });
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
      const MONTH_NAMES = { 9: 'ספט׳', 10: 'אוק׳', 11: 'נוב׳', 12: 'דצמ׳', 1: 'ינו׳', 2: 'פבר׳', 3: 'מרץ', 4: 'אפר׳', 5: 'מאי', 6: 'יוני', 7: 'יולי', 8: 'אוג׳' };

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

    const academicYear = getAcademicYearStr(registration.start_date)
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
  recalculate, getHistory, backup,
};
