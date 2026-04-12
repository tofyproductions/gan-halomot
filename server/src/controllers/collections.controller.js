const db = require('../config/database');
const { normalizeYear, getAcademicYears, ACADEMIC_MONTHS } = require('../services/academic-year.service');
const { calculatePaymentStatus } = require('../services/prorate.service');

/**
 * GET /api/collections?year=2025
 * Complex join: registrations + children + collections + collection_months
 * Grouped by classroom with expected fees calculated via prorate service
 */
async function getAll(req, res, next) {
  try {
    const { year } = req.query;
    const academicYears = getAcademicYears();
    const targetYear = year
      ? normalizeYear(year)
      : academicYears.current.range;

    // Get all completed registrations for the target academic year
    const registrations = await db('registrations')
      .select(
        'registrations.*',
        'classrooms.name as classroom_name',
        'children.id as child_id',
        'children.child_name as child_display_name'
      )
      .leftJoin('classrooms', 'registrations.classroom_id', 'classrooms.id')
      .leftJoin('children', function () {
        this.on('children.registration_id', '=', 'registrations.id')
          .andOn('children.is_active', '=', db.raw('true'));
      })
      .where('registrations.status', 'completed')
      .orderBy('classrooms.name')
      .orderBy('registrations.child_name');

    // Filter registrations by academic year date range
    const [y1, y2] = targetYear.split('-').map(Number);
    const filteredRegs = registrations.filter(r => {
      if (!r.start_date) return false;
      const startDate = new Date(r.start_date);
      const acadStart = new Date(y1, 8, 1);
      const acadEnd = new Date(y2, 7, 31);
      return startDate <= acadEnd;
    });

    // Get all collections for these registrations
    const regIds = filteredRegs.map(r => r.id);
    let collections = [];
    let collectionMonths = [];

    if (regIds.length > 0) {
      collections = await db('collections')
        .whereIn('registration_id', regIds)
        .andWhere('academic_year', targetYear);

      const collectionIds = collections.map(c => c.id);
      if (collectionIds.length > 0) {
        collectionMonths = await db('collection_months')
          .whereIn('collection_id', collectionIds);
      }
    }

    // Build lookup maps
    const collectionByReg = {};
    for (const c of collections) {
      collectionByReg[c.registration_id] = c;
    }

    const monthsByCollection = {};
    for (const cm of collectionMonths) {
      if (!monthsByCollection[cm.collection_id]) {
        monthsByCollection[cm.collection_id] = {};
      }
      monthsByCollection[cm.collection_id][cm.month_number] = cm;
    }

    // Build grouped result
    const grouped = {};
    for (const reg of filteredRegs) {
      const groupName = reg.classroom_name || 'ללא קבוצה';
      if (!grouped[groupName]) {
        grouped[groupName] = [];
      }

      const collection = collectionByReg[reg.id] || null;
      const months = collection ? (monthsByCollection[collection.id] || {}) : {};

      // Calculate expected fees
      const fee = parseFloat(reg.monthly_fee) || 0;
      const endDate = collection && collection.exit_month
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

      // Build month data array
      const monthData = ACADEMIC_MONTHS.map(m => {
        const existing = months[m] || {};
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
        registration_id: reg.id,
        unique_id: reg.unique_id,
        child_name: reg.child_name,
        child_id: reg.child_id,
        parent_name: reg.parent_name,
        monthly_fee: fee,
        start_date: reg.start_date,
        end_date: reg.end_date,
        collection_id: collection ? collection.id : null,
        exit_month: collection ? collection.exit_month : null,
        registration_fee_receipt: collection ? collection.registration_fee_receipt : null,
        months: monthData,
      });
    }

    res.json({
      collections: grouped,
      academicYear: targetYear,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/collections/:registrationId
 * Get collection data for a single registration
 */
async function getByRegistration(req, res, next) {
  try {
    const { registrationId } = req.params;

    const registration = await db('registrations')
      .select('registrations.*', 'classrooms.name as classroom_name')
      .leftJoin('classrooms', 'registrations.classroom_id', 'classrooms.id')
      .where('registrations.id', registrationId)
      .first();

    if (!registration) {
      return res.status(404).json({ error: 'Registration not found' });
    }

    const collection = await db('collections')
      .where({ registration_id: registrationId })
      .first();

    let months = [];
    if (collection) {
      months = await db('collection_months')
        .where({ collection_id: collection.id })
        .orderBy('month_number');
    }

    res.json({ registration, collection, months });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/collections/:registrationId/month/:monthIndex
 * Upsert collection + collection_month record
 * CHECK for duplicate receipt numbers
 */
async function updateMonth(req, res, next) {
  try {
    const { registrationId, monthIndex } = req.params;
    const { receipt_number, paid_amount, payment_status, notes } = req.body;
    const monthNum = parseInt(monthIndex);

    if (isNaN(monthNum) || monthNum < 1 || monthNum > 12) {
      return res.status(400).json({ error: 'Invalid month index (1-12)' });
    }

    const registration = await db('registrations').where({ id: registrationId }).first();
    if (!registration) {
      return res.status(404).json({ error: 'Registration not found' });
    }

    // Check for duplicate receipt numbers across ALL records
    if (receipt_number) {
      const duplicate = await db('collection_months')
        .where('receipt_number', receipt_number)
        .whereNot(function () {
          this.whereIn('collection_id', function () {
            this.select('id').from('collections').where('registration_id', registrationId);
          }).andWhere('month_number', monthNum);
        })
        .first();

      if (duplicate) {
        return res.status(409).json({
          error: 'Duplicate receipt number',
          message: `Receipt number ${receipt_number} already exists in another record`,
        });
      }
    }

    // Determine academic year
    const academicYears = getAcademicYears();
    const { getAcademicYearStr } = require('../services/academic-year.service');
    const academicYear = getAcademicYearStr(registration.start_date) || academicYears.current.range;

    // Get child linked to this registration
    const child = await db('children')
      .where({ registration_id: registrationId, is_active: true })
      .first();

    await db.transaction(async trx => {
      // Upsert collection
      let collection = await trx('collections')
        .where({ registration_id: parseInt(registrationId), academic_year: academicYear })
        .first();

      if (!collection) {
        [collection] = await trx('collections')
          .insert({
            registration_id: parseInt(registrationId),
            child_id: child ? child.id : null,
            academic_year: academicYear,
          })
          .returning('*');
      }

      // Upsert collection_month
      const existingMonth = await trx('collection_months')
        .where({ collection_id: collection.id, month_number: monthNum })
        .first();

      const monthData = {
        paid_amount: paid_amount !== undefined ? paid_amount : (existingMonth ? existingMonth.paid_amount : 0),
        receipt_number: receipt_number !== undefined ? receipt_number : (existingMonth ? existingMonth.receipt_number : null),
        payment_status: payment_status || (receipt_number ? 'paid' : (existingMonth ? existingMonth.payment_status : 'expected')),
        payment_date: receipt_number ? new Date() : (existingMonth ? existingMonth.payment_date : null),
        notes: notes !== undefined ? notes : (existingMonth ? existingMonth.notes : null),
      };

      if (existingMonth) {
        await trx('collection_months')
          .where({ id: existingMonth.id })
          .update(monthData);
      } else {
        await trx('collection_months').insert({
          collection_id: collection.id,
          month_number: monthNum,
          ...monthData,
        });
      }

      // Update collection timestamp
      await trx('collections')
        .where({ id: collection.id })
        .update({ last_updated: new Date() });
    });

    res.json({ message: 'Month updated successfully' });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/collections/:registrationId/exit-month
 * Update exit month for a registration's collection
 */
async function updateExitMonth(req, res, next) {
  try {
    const { registrationId } = req.params;
    const { exit_month } = req.body;

    const collection = await db('collections')
      .where({ registration_id: registrationId })
      .first();

    if (!collection) {
      return res.status(404).json({ error: 'Collection not found for this registration' });
    }

    await db('collections')
      .where({ id: collection.id })
      .update({
        exit_month: exit_month || null,
        last_updated: new Date(),
      });

    res.json({ message: 'Exit month updated', exit_month });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/collections/:registrationId/recalculate
 * Recalculate all expected fees for a registration
 */
async function recalculate(req, res, next) {
  try {
    const { registrationId } = req.params;

    const registration = await db('registrations').where({ id: registrationId }).first();
    if (!registration) {
      return res.status(404).json({ error: 'Registration not found' });
    }

    const collection = await db('collections')
      .where({ registration_id: registrationId })
      .first();

    if (!collection) {
      return res.status(404).json({ error: 'No collection record found' });
    }

    const fee = parseFloat(registration.monthly_fee) || 0;
    const academicYear = collection.academic_year;
    const [y1, y2] = academicYear.split('-').map(Number);

    // Determine effective end date based on exit month
    let endDate = registration.end_date;
    if (collection.exit_month) {
      const exitM = collection.exit_month;
      const exitY = exitM >= 9 ? y1 : y2;
      endDate = new Date(exitY, exitM, 0).toISOString().split('T')[0]; // last day of exit month
    }

    // Check for price adjustments
    const priceAdj = await db('price_adjustments')
      .where({ registration_id: registrationId })
      .orderBy('effective_month')
      .first();

    const { expectedFees, isBeforeStart } = calculatePaymentStatus(
      fee,
      registration.start_date,
      academicYear,
      endDate,
      priceAdj ? priceAdj.effective_month : null,
      priceAdj ? priceAdj.new_monthly_fee : null
    );

    // Update each month's expected amount
    await db.transaction(async trx => {
      for (const m of ACADEMIC_MONTHS) {
        const existing = await trx('collection_months')
          .where({ collection_id: collection.id, month_number: m })
          .first();

        if (existing) {
          await trx('collection_months')
            .where({ id: existing.id })
            .update({ expected_amount: expectedFees[m] || 0 });
        } else {
          await trx('collection_months').insert({
            collection_id: collection.id,
            month_number: m,
            expected_amount: expectedFees[m] || 0,
            payment_status: isBeforeStart[m] ? 'pending' : 'expected',
          });
        }
      }

      await trx('collections')
        .where({ id: collection.id })
        .update({ last_updated: new Date() });
    });

    res.json({ message: 'Fees recalculated', expectedFees });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/collections/history
 * Return grouped backup history from collection_history table
 */
async function getHistory(req, res, next) {
  try {
    const history = await db('collection_history')
      .orderBy('archived_at', 'desc');

    // Group by archived_at date
    const grouped = {};
    for (const entry of history) {
      const dateKey = new Date(entry.archived_at).toLocaleDateString('he-IL');
      if (!grouped[dateKey]) {
        grouped[dateKey] = [];
      }
      grouped[dateKey].push({
        id: entry.id,
        child_name: entry.child_name,
        academic_year: entry.academic_year,
        collection_data: typeof entry.collection_data === 'string'
          ? JSON.parse(entry.collection_data)
          : entry.collection_data,
        archived_at: entry.archived_at,
      });
    }

    res.json({ history: grouped });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/collections/backup
 * Snapshot current collections to collection_history
 */
async function backup(req, res, next) {
  try {
    const collections = await db('collections')
      .select(
        'collections.*',
        'registrations.child_name',
        'registrations.parent_name',
        'registrations.monthly_fee'
      )
      .leftJoin('registrations', 'collections.registration_id', 'registrations.id');

    if (collections.length === 0) {
      return res.status(400).json({ error: 'No collections data to backup' });
    }

    const inserts = [];
    for (const col of collections) {
      // Get all month data for this collection
      const months = await db('collection_months')
        .where({ collection_id: col.id });

      inserts.push({
        child_name: col.child_name,
        academic_year: col.academic_year,
        collection_data: JSON.stringify({
          ...col,
          months,
        }),
      });
    }

    await db('collection_history').insert(inserts);

    res.json({
      message: 'Collections backed up successfully',
      count: inserts.length,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getAll,
  getByRegistration,
  updateMonth,
  updateExitMonth,
  recalculate,
  getHistory,
  backup,
};
