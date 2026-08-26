const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const authController = require('../controllers/auth.controller');

// POST /api/auth/login (public) — step 1: name + id
router.post('/login', authController.login);
// POST /api/auth/login-password (public) — step 2: name + id + password
router.post('/login-password', authController.loginWithPassword);
// POST /api/auth/set-password (auth) — user chooses/changes their login password
router.post('/set-password', authMiddleware, authController.setPassword);

// Forgotten password, without a telephone call to an administrator.
// Public, because somebody who cannot log in cannot be asked to log in first.
// POST /api/auth/forgot-password — texts a code to the phone we already hold
router.post('/forgot-password', authController.forgotPassword);
// POST /api/auth/reset-with-code — code + a new password, and they are in
router.post('/reset-with-code', authController.resetWithCode);

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
