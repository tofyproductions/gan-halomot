const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const authController = require('../controllers/auth.controller');

// POST /api/auth/login (public)
router.post('/login', authController.login);

// POST /api/auth/logout (public)
router.post('/logout', authController.logout);

// GET /api/auth/me (requires auth)
router.get('/me', authMiddleware, authController.me);

module.exports = router;
