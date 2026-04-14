const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { User } = require('../models');
const env = require('../config/env');

async function login(req, res, next) {
  try {
    const { id_number, password } = req.body;
    if (!id_number || !password) {
      return res.status(400).json({ error: 'תעודת זהות וסיסמה נדרשים' });
    }

    const cleaned = id_number.replace(/\D/g, '').trim();
    const user = await User.findOne({ id_number: cleaned, is_active: true })
      .populate('branch_id', 'name');

    if (!user) {
      return res.status(401).json({ error: 'תעודת זהות או סיסמה שגויים' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'תעודת זהות או סיסמה שגויים' });
    }

    const payload = {
      id: user._id,
      email: user.email,
      full_name: user.full_name,
      role: user.role,
      branch_id: user.branch_id?._id || user.branch_id,
      branch_name: user.branch_id?.name || null,
      position: user.position,
    };

    const token = jwt.sign(payload, env.JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, user: payload });
  } catch (error) {
    next(error);
  }
}

async function logout(req, res, next) {
  try {
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    next(error);
  }
}

async function me(req, res, next) {
  try {
    const user = await User.findById(req.user.id)
      .select('-password_hash')
      .populate('branch_id', 'name');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({
      user: {
        ...user.toObject(),
        id: user._id,
        branch_name: user.branch_id?.name || null,
      },
    });
  } catch (error) {
    next(error);
  }
}

module.exports = { login, logout, me };
