const router = require('express').Router();
const { authMiddleware } = require('../middleware/auth');

// Public routes (no auth)
router.use('/auth', require('./auth.routes'));
router.use('/public', require('./public.routes'));

// Protected routes (auth required)
router.use('/dashboard', authMiddleware, require('./dashboard.routes'));
router.use('/children', authMiddleware, require('./children.routes'));
router.use('/registrations', authMiddleware, require('./registration.routes'));
router.use('/contracts', authMiddleware, require('./contracts.routes'));
router.use('/collections', authMiddleware, require('./collections.routes'));
router.use('/archives', authMiddleware, require('./archive.routes'));
router.use('/contacts', authMiddleware, require('./contacts.routes'));
router.use('/classrooms', authMiddleware, require('./classroom.routes'));
router.use('/documents', authMiddleware, require('./documents.routes'));
router.use('/utils', require('./utils.routes'));

module.exports = router;
