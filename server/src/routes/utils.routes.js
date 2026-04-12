const express = require('express');
const router = express.Router();
const utilsController = require('../controllers/utils.controller');

// GET /api/utils/academic-years
router.get('/academic-years', utilsController.getAcademicYears);

// GET /api/utils/hebrew-year-info
router.get('/hebrew-year-info', utilsController.getHebrewYearInfo);

module.exports = router;
