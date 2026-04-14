const express = require('express');
const router = express.Router();
const c = require('../controllers/discount.controller');

router.get('/', c.getAll);
router.post('/', c.create);
router.put('/:id', c.update);
router.delete('/:id', c.remove);
router.get('/for/:registrationId/:month', c.getForRegistration);

module.exports = router;
