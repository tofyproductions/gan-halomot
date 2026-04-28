const express = require('express');
const router = express.Router();
const registrationController = require('../controllers/registration.controller');

// GET /api/registration
router.get('/', registrationController.getAll);

// POST /api/registration/fix-orphan-branch — assign null-branch regs to a branch
router.post('/fix-orphan-branch', registrationController.fixOrphanBranch);

// GET /api/registration/:id
router.get('/:id', registrationController.getById);

// POST /api/registration
router.post('/', registrationController.create);

// PUT /api/registration/:id
router.put('/:id', registrationController.update);

// POST /api/registration/:id/generate-link
router.post('/:id/generate-link', registrationController.generateLink);

// POST /api/registration/:id/activate
router.post('/:id/activate', registrationController.activate);

// DELETE /api/registration/:id
router.delete('/:id', registrationController.remove);

module.exports = router;
