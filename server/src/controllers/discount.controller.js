const mongoose = require('mongoose');
const { Discount, Registration, Classroom } = require('../models');
const { getBranchFilter } = require('../utils/branch-filter');

/**
 * Resolve the branch a discount belongs to. The cross-branch view sends the
 * sentinel "all" (not an ObjectId), which used to blow up on cast — so when the
 * given branch isn't a real id we derive it from the discount's target.
 */
async function resolveDiscountBranch({ branch_id, scope, registration_id, classroom_id }) {
  if (branch_id && mongoose.isValidObjectId(branch_id)) return branch_id;
  if (scope === 'child' && mongoose.isValidObjectId(registration_id)) {
    const reg = await Registration.findById(registration_id).select('branch_id').lean();
    if (reg?.branch_id) return reg.branch_id;
  }
  if (scope === 'classroom' && mongoose.isValidObjectId(classroom_id)) {
    const room = await Classroom.findById(classroom_id).select('branch_id').lean();
    if (room?.branch_id) return room.branch_id;
  }
  return null;
}

async function getAll(req, res, next) {
  try {
    const filter = { is_active: true, ...getBranchFilter(req) };
    // Year-scoped, but keep legacy rows that were saved without an academic_year
    // visible so filtering doesn't make existing discounts disappear.
    if (req.query.year) {
      filter.$or = [
        { academic_year: req.query.year },
        { academic_year: '' },
        { academic_year: null },
        { academic_year: { $exists: false } },
      ];
    }

    const discounts = await Discount.find(filter)
      .populate('registration_id', 'child_name parent_name')
      .populate('classroom_id', 'name')
      .sort({ created_at: -1 })
      .lean();

    res.json({
      discounts: discounts.map(d => ({
        ...d, id: d._id,
        child_name: d.registration_id?.child_name || null,
        parent_name: d.registration_id?.parent_name || null,
        classroom_name: d.classroom_id?.name || null,
      })),
    });
  } catch (error) { next(error); }
}

async function create(req, res, next) {
  try {
    const { branch_id, scope, registration_id, classroom_id, discount_type, value, month, academic_year, reason } = req.body;
    if (!scope || !discount_type || !value) {
      return res.status(400).json({ error: 'scope, discount_type, value חובה' });
    }

    const resolvedBranch = await resolveDiscountBranch({
      branch_id: branch_id || req.query.branch,
      scope, registration_id, classroom_id,
    });
    if (!resolvedBranch) {
      return res.status(400).json({
        error: scope === 'branch'
          ? 'יש לבחור סניף ספציפי (לא "כל הסניפים") להנחה לכל הגן'
          : 'לא ניתן לקבוע את הסניף להנחה — בחר/י יעד תקין',
      });
    }

    const discount = await Discount.create({
      branch_id: resolvedBranch,
      scope, registration_id: registration_id || null,
      classroom_id: classroom_id || null,
      discount_type, value, month: month || null,
      academic_year: academic_year || '',
      reason: reason || '',
    });

    res.status(201).json({ discount: { ...discount.toObject(), id: discount._id } });
  } catch (error) { next(error); }
}

async function update(req, res, next) {
  try {
    const d = await Discount.findById(req.params.id);
    if (!d) return res.status(404).json({ error: 'הנחה לא נמצאה' });
    ['discount_type', 'value', 'month', 'reason', 'scope', 'registration_id', 'classroom_id'].forEach(f => {
      if (req.body[f] !== undefined) d[f] = req.body[f];
    });
    await d.save();
    res.json({ discount: { ...d.toObject(), id: d._id } });
  } catch (error) { next(error); }
}

async function remove(req, res, next) {
  try {
    await Discount.findByIdAndUpdate(req.params.id, { is_active: false });
    res.json({ message: 'הנחה הוסרה' });
  } catch (error) { next(error); }
}

// Get applicable discounts for a specific registration+month
async function getForRegistration(req, res, next) {
  try {
    const { registrationId, month } = req.params;
    const { Registration } = require('../models');
    const reg = await Registration.findById(registrationId);
    if (!reg) return res.status(404).json({ error: 'רישום לא נמצא' });

    const filter = {
      is_active: true,
      branch_id: reg.branch_id,
      $or: [
        { scope: 'child', registration_id: registrationId },
        { scope: 'classroom', classroom_id: reg.classroom_id },
        { scope: 'branch' },
      ],
    };

    const discounts = await Discount.find(filter).lean();

    // Filter by month
    const applicable = discounts.filter(d =>
      !d.month || d.month === parseInt(month)
    );

    // Calculate total discount
    let totalDiscount = 0;
    const fee = parseFloat(reg.monthly_fee) || 0;

    for (const d of applicable) {
      if (d.discount_type === 'percentage') {
        totalDiscount += fee * (d.value / 100);
      } else {
        totalDiscount += d.value;
      }
    }

    res.json({
      discounts: applicable,
      original_fee: fee,
      total_discount: Math.round(totalDiscount),
      final_fee: Math.max(0, fee - Math.round(totalDiscount)),
    });
  } catch (error) { next(error); }
}

module.exports = { getAll, create, update, remove, getForRegistration };
