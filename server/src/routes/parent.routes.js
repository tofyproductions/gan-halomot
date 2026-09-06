const router = require('express').Router();
const auth = require('../controllers/parentAuth.controller');
const multer = require('multer');
const { parentAuthMiddleware } = require('../middleware/parentAuth');
const { MAX_UPLOAD_BYTES } = require('../services/photo.service');

// In memory: every upload is resized and forwarded to object storage at once,
// and Render's disk is ephemeral. Five at a time — a parent picking a photo
// for a gift, not emptying a camera roll.
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 5 },
});

/**
 * The parent portal, mounted ABOVE the staff `authMiddleware` in routes/index.
 *
 * That placement is the point: nothing in here is ever reached by the staff
 * guard, and nothing under it is ever reached by a parent's token. The two
 * sides of the application do not share a gate — see middleware/parentAuth.js
 * for why sharing one would have opened every authenticate-only staff route to
 * several hundred outsiders.
 *
 * Anonymous by necessity: a parent activating an account has no token yet.
 * What protects these four is the one-time code and its throttles
 * (services/parentOtp.service.js), not the router.
 */
router.post('/auth/start', auth.start);
router.post('/auth/verify', auth.verify);
router.post('/auth/set-password', auth.setPassword);
router.post('/auth/login', auth.login);

// Everything below needs a parent token.
router.use(parentAuthMiddleware);
router.get('/me', auth.me);

const push = require('../controllers/push.controller');
router.post('/push/register', push.registerParent);
router.post('/push/unregister', push.unregister);

// Every one of these resolves the parent's children afresh and refuses an id
// that is not among them — see parentPortal.controller.
const portal = require('../controllers/parentPortal.controller');
router.get('/editable-fields', portal.editableFields);
router.get('/children/:childId', portal.childDetails);
router.patch('/children/:childId', portal.updateChild);
// Adding the child's other parent. Only ever adds, and grants nothing — the
// account it creates waits for the gan (see parentPortal.controller).
router.post('/children/:childId/second-parent', portal.addSecondParent);
// The תינוקייה's day. Read by any parent of an infant; written only for the
// four fields describing the morning at home, and only for today.
router.get('/children/:childId/day', portal.childDay);
router.patch('/children/:childId/day', portal.updateChildDay);
// Photographs. Two streams on the way out — the child's own, and the
// classroom's week — and a parent's upload is only ever their own child's.
router.get('/children/:childId/photos', portal.childPhotos);
router.post('/children/:childId/photos', photoUpload.array('photos', 5), portal.uploadChildPhoto);
// The gift round: what the family chose, and the photographs they may choose
// from — their child's own, never the classroom gallery.
router.get('/children/:childId/gift', portal.childGift);
router.put('/children/:childId/gift', portal.setChildGift);
// What the gan has told this family. Published only, unexpired only, and
// scoped to this child's classroom or to the whole branch.
const announcements = require('../controllers/parentAnnouncements.controller');
router.get('/children/:childId/announcements', announcements.childAnnouncements);
// Who else may collect the child. Adding waits for the gan; removing does not.
const pickup = require('../controllers/parentPickup.controller');
router.get('/children/:childId/pickup', pickup.list);
router.post('/children/:childId/pickup', pickup.add);
router.delete('/children/:childId/pickup/:id', pickup.revoke);
// "לא מגיעה מחר". Today or later only — a report about a day that already
// happened would be a family editing the gan's own record of it.
const absence = require('../controllers/parentAbsence.controller');
router.get('/children/:childId/absences', absence.list);
router.post('/children/:childId/absences', absence.create);
router.delete('/children/:childId/absences/:date', absence.cancel);
// What the family owes. Read-only — nothing in the parent portal moves money.
const payments = require('../controllers/parentPayments.controller');
// גאנט — only for a week the gan published, and only once approved.
router.get('/children/:childId/gantt', portal.childGantt);

// מה חסר — read-only; only the room can see the shelf.
router.get('/children/:childId/supplies', portal.childSupplies);

// לוח חופשות — read-only, and the same merged view the office sees.
router.get('/children/:childId/vacations', portal.childVacations);

router.get('/children/:childId/payments', payments.childPayments);
router.get('/children/:childId/contracts', portal.childContracts);
router.get('/children/:childId/contracts/:contractId/file', portal.contractFile);

// Changing the phone is its own two-step flow, because the code has to go to
// the new number — see parentPortal.controller.
router.post('/phone/start', portal.startPhoneChange);
router.post('/phone/confirm', portal.confirmPhoneChange);

module.exports = router;
