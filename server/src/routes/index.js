const router = require('express').Router();

// All routes open (no auth required - matching original GAS app behavior)
router.use('/branches', require('./branch.routes'));
router.use('/auth', require('./auth.routes'));
router.use('/public', require('./public.routes'));
router.use('/dashboard', require('./dashboard.routes'));
router.use('/children', require('./children.routes'));
router.use('/registrations', require('./registration.routes'));
router.use('/contracts', require('./contracts.routes'));
router.use('/collections', require('./collections.routes'));
router.use('/archives', require('./archive.routes'));
router.use('/contacts', require('./contacts.routes'));
router.use('/classrooms', require('./classroom.routes'));
router.use('/documents', require('./documents.routes'));
router.use('/suppliers', require('./supplier.routes'));
router.use('/products', require('./product.routes'));
router.use('/orders', require('./order.routes'));
router.use('/utils', require('./utils.routes'));

module.exports = router;
