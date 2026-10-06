const router = require('express').Router();
const { wrapControllers } = require('../utils/asyncWrap');
const ctrl = wrapControllers(require('../controllers/graphics.controller'));
const { requireTab } = require('../middleware/auth');

/**
 * הגרפיקות שלנו — the printables.
 *
 * Open to management, branch managers and class leaders: the person who wants
 * a birthday card is the one standing in the room on the morning of the
 * birthday, and a card she has to ask the office for is a card that arrives
 * the day after. Wider than מעקב הורים רשומים because nothing here is a
 * family's private detail — a first name and a date, which the room's own
 * wall calendar has carried for years.
 *
 * Read only. Nothing on this screen writes, and the cards are rendered on
 * demand rather than stored.
 */
const allow = requireTab('graphics', 'system_admin', 'admin_viewer', 'branch_manager', 'class_leader');

router.get('/birthdays', allow, ctrl.birthdayList);
router.get('/birthday-card', allow, ctrl.birthdayCard);

module.exports = router;
