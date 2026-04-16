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

// WebAuthn registration (requires auth — user must be logged in)
router.post('/webauthn/register/options', authMiddleware, authController.webauthnRegisterOptions);
router.post('/webauthn/register/verify', authMiddleware, authController.webauthnRegisterVerify);

// WebAuthn authentication (public — this IS the login)
router.post('/webauthn/auth/options', authController.webauthnAuthOptions);
router.post('/webauthn/auth/verify', authController.webauthnAuthVerify);

module.exports = router;
