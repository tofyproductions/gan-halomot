const { Branch, User } = require('../models');

async function getAll(req, res, next) {
  try {
    const filter = { is_active: true };
    // Non-admins see only the branches they manage. system_admin and
    // accountant always see all branches (accountant needs cross-branch
    // visibility for payroll consolidation).
    //
    // Re-read role + managed branches from the DB rather than trusting the JWT:
    // a token issued before a role/branch change would otherwise keep showing
    // stale (often too many) branches until it expires.
    const uid = req.user?.id || req.user?._id;
    const dbUser = uid
      ? await User.findById(uid).select('role managed_branch_ids branch_id').lean()
      : null;
    const role = dbUser?.role || req.user?.role;
    const managedRaw = dbUser ? (dbUser.managed_branch_ids || []) : (req.user?.managed_branch_ids || []);
    const userBranchId = dbUser ? dbUser.branch_id : req.user?.branch_id;
    if (role && role !== 'system_admin' && role !== 'accountant') {
      const managed = managedRaw.map(String);
      if (managed.length > 0) {
        filter._id = { $in: managed };
      } else if (userBranchId) {
        filter._id = userBranchId;
      } else {
        // Authenticated user with no branch — return empty list rather than all
        return res.json({ branches: [] });
      }
    }
    const branches = await Branch.find(filter).sort({ name: 1 }).lean();
    res.json({ branches: branches.map(b => ({ ...b, id: b._id })) });
  } catch (error) {
    next(error);
  }
}

async function create(req, res, next) {
  try {
    const { name, address } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    const existing = await Branch.findOne({ name });
    if (existing) {
      return res.status(409).json({ error: 'סניף עם שם זה כבר קיים' });
    }

    const branch = await Branch.create({ name, address: address || '' });
    res.status(201).json({ branch: { ...branch.toObject(), id: branch._id } });
  } catch (error) {
    next(error);
  }
}

async function update(req, res, next) {
  try {
    const { id } = req.params;
    const {
      name, address, color, tmt_supervised, licensed_capacity,
    } = req.body;

    const branch = await Branch.findById(id);
    if (!branch) {
      return res.status(404).json({ error: 'Branch not found' });
    }

    if (name) branch.name = name;
    if (address !== undefined) branch.address = address;
    if (color !== undefined) branch.color = color;
    // Whether the gan enrolls through משרד התמ"ת. Settable, because the
    // fallback that reads it off the branch name is a stopgap for old rows.
    if (tmt_supervised !== undefined) {
      branch.tmt_supervised = tmt_supervised === null ? null : !!tmt_supervised;
    }
    // The ministry's licensed head count. Empty clears it — "not told yet" and
    // "licensed for zero" are different answers.
    if (licensed_capacity !== undefined) {
      const n = Number(licensed_capacity);
      branch.licensed_capacity = (licensed_capacity === null || licensed_capacity === '' || !Number.isFinite(n))
        ? null : Math.max(0, Math.round(n));
    }
    await branch.save();

    res.json({ branch: { ...branch.toObject(), id: branch._id } });
  } catch (error) {
    next(error);
  }
}

async function remove(req, res, next) {
  try {
    const { id } = req.params;
    const branch = await Branch.findById(id);
    if (!branch) {
      return res.status(404).json({ error: 'Branch not found' });
    }

    branch.is_active = false;
    await branch.save();

    res.json({ message: 'סניף הוסר', id });
  } catch (error) {
    next(error);
  }
}

module.exports = { getAll, create, update, remove };
