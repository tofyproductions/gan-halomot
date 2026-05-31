const { BranchPricing, Branch } = require('../models');

// Fields the client is allowed to set on a pricing doc.
const EDITABLE = [
  'academic_year', 'pricing_type', 'fixed_monthly_fee',
  'age_groups', 'tiers', 'addons', 'one_time', 'notes',
];

// List every branch alongside its pricing doc (or null if not set yet), so the
// UI can show all branches even before any price was defined.
async function getAll(req, res, next) {
  try {
    const branchFilter = {};
    if (req.query.branch && req.query.branch !== 'all') branchFilter._id = req.query.branch;

    const branches = await Branch.find({ is_active: true, ...branchFilter })
      .select('name color')
      .sort({ name: 1 })
      .lean();

    const pricings = await BranchPricing.find().lean();
    const byBranch = new Map(pricings.map(p => [String(p.branch_id), p]));

    res.json({
      pricing: branches.map(b => {
        const p = byBranch.get(String(b._id));
        return {
          branch_id: b._id,
          branch_name: b.name,
          branch_color: b.color || '',
          pricing: p ? { ...p, id: p._id } : null,
        };
      }),
    });
  } catch (error) { next(error); }
}

// Get one branch's pricing doc for a given academic year (null if none yet).
async function getForBranch(req, res, next) {
  try {
    const academic_year = req.query.year || '';
    const p = await BranchPricing.findOne({ branch_id: req.params.branchId, academic_year }).lean();
    res.json({ pricing: p ? { ...p, id: p._id } : null });
  } catch (error) { next(error); }
}

// Create or update the pricing for a branch (upsert by branch_id + academic_year).
async function upsert(req, res, next) {
  try {
    const { branchId } = req.params;
    const branch = await Branch.findById(branchId);
    if (!branch) return res.status(404).json({ error: 'סניף לא נמצא' });

    const academic_year = req.body.academic_year || '';
    const patch = {};
    EDITABLE.forEach(f => { if (req.body[f] !== undefined) patch[f] = req.body[f]; });

    const doc = await BranchPricing.findOneAndUpdate(
      { branch_id: branchId, academic_year },
      { $set: { ...patch, branch_id: branchId, academic_year } },
      { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true },
    ).lean();

    res.json({ pricing: { ...doc, id: doc._id } });
  } catch (error) { next(error); }
}

module.exports = { getAll, getForBranch, upsert };
