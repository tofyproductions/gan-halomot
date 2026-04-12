const { Registration, Classroom, Child, Collection, CollectionHistory, PriceAdjustment } = require('../models');
const { normalizeYear, getAcademicYears, getAcademicYearStr, ACADEMIC_MONTHS } = require('../services/academic-year.service');
const { calculatePaymentStatus } = require('../services/prorate.service');

async function getAll(req, res, next) {
  try {
    const { year } = req.query;
    const academicYears = getAcademicYears();
    const targetYear = year ? normalizeYear(year) : academicYears.current.range;

    const registrations = await Registration.find({ status: 'completed' })
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

      const monthData = ACADEMIC_MONTHS.map(m => {
        const existing = monthsMap[m] || {};
        return {
          month: m,
          expected_amount: expectedFees[m] || 0,
          paid_amount: parseFloat(existing.paid_amount) || 0,
          receipt_number: existing.receipt_number || null,
          payment_status: existing.payment_status || (isBeforeStart[m] ? 'pending' : 'expected'),
          payment_date: existing.payment_date || null,
          is_prorated: existing.is_prorated || false,
          is_before_start: isBeforeStart[m] || false,
          notes: existing.notes || null,
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
        registration_fee_receipt: collection?.registration_fee_receipt || null,
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
    const { receipt_number, paid_amount, payment_status, notes } = req.body;
    const monthNum = parseInt(monthIndex);

    if (isNaN(monthNum) || monthNum < 1 || monthNum > 12) {
      return res.status(400).json({ error: 'Invalid month index (1-12)' });
    }

    const registration = await Registration.findById(registrationId);
    if (!registration) {
      return res.status(404).json({ error: 'Registration not found' });
    }

    // Check for duplicate receipt numbers
    if (receipt_number) {
      const duplicate = await Collection.findOne({
        'months.receipt_number': receipt_number,
        $or: [
          { registration_id: { $ne: registrationId } },
          { 'months': { $elemMatch: { receipt_number, month_number: { $ne: monthNum } } } },
        ],
      });
      if (duplicate) {
        return res.status(409).json({
          error: 'Duplicate receipt number',
          message: `Receipt number ${receipt_number} already exists in another record`,
        });
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

    // Find existing month in array
    const existingIdx = collection.months.findIndex(m => m.month_number === monthNum);
    const existing = existingIdx >= 0 ? collection.months[existingIdx] : null;

    const monthData = {
      month_number: monthNum,
      paid_amount: paid_amount !== undefined ? paid_amount : (existing?.paid_amount || 0),
      receipt_number: receipt_number !== undefined ? receipt_number : (existing?.receipt_number || null),
      payment_status: payment_status || (receipt_number ? 'paid' : (existing?.payment_status || 'expected')),
      payment_date: receipt_number ? new Date() : (existing?.payment_date || null),
      notes: notes !== undefined ? notes : (existing?.notes || null),
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
