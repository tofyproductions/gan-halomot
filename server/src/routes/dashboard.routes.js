const express = require('express');
const router = express.Router();
const dashboardController = require('../controllers/dashboard.controller');

// GET /api/dashboard/stats
router.get('/stats', dashboardController.getStats);

// GET /api/dashboard/classrooms?year=2026
router.get('/classrooms', dashboardController.getClassrooms);

module.exports = router;
