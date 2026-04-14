const { Branch } = require('../models');

async function getAll(req, res, next) {
  try {
    const branches = await Branch.find({ is_active: true }).sort({ name: 1 }).lean();
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
    const { name, address } = req.body;

    const branch = await Branch.findById(id);
    if (!branch) {
      return res.status(404).json({ error: 'Branch not found' });
    }

    if (name) branch.name = name;
    if (address !== undefined) branch.address = address;
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
