const router = require('express').Router();
const ctrl = require('../controllers/absences.controller');
const { requireTab } = require('../middleware/auth');

/**
 * היעדרויות — what the families reported in advance.
 *
 * Open to the people who open the room. A teacher needs the morning list
 * before the morning; gating it on management would mean she finds out that a
 * child is not coming when the child does not come.
 *
 * READ ONLY, and there is no write route here by design. The parent reports
 * and withdraws from the portal, and what the staff record is the day's own
 * attendance on the nursery board — two people writing the same fact in two
 * places is how the two stop agreeing.
 */
const allow = requireTab('absences', 'system_admin', 'branch_manager', 'accountant', 'class_leader', 'teacher');

// Above /:anything, and there is nothing else, but the habit is cheap.
router.get('/report', allow, ctrl.report);
router.get('/', allow, ctrl.day);

module.exports = router;
