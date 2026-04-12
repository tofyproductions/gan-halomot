const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { User } = require('../models');
const env = require('../config/env');

async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const payload = {
      id: user._id,
      email: user.email,
      full_name: user.full_name,
      role: user.role,
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
    const user = await User.findById(req.user.id).select('email full_name role created_at');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user });
  } catch (error) {
    next(error);
  }
}

module.exports = { login, logout, me };
