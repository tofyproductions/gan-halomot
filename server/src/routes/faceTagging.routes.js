const router = require('express').Router();
const ctrl = require('../controllers/faceTagging.controller');
const { requireTab } = require('../middleware/auth');

/**
 * The teachers' face-tagging queue.
 *
 * Same audience as uploading photographs, and deliberately so: the person who
 * took the picture is the person who knows who is in it, and routing this to
 * managers instead would mean it happens a week later or not at all.
 *
 * The controller narrows every one of these to the rooms the caller may act
 * on, using the photo screen's own rule rather than a second copy of it.
 */
const allow = requireTab(
  'nursery', 'system_admin', 'branch_manager', 'class_leader',
  'teacher', 'assistant', 'classroom_board',
);

router.get('/queue', allow, ctrl.getQueue);
router.get('/candidates', allow, ctrl.getCandidates);
router.get('/crop/:photoId/:faceIndex', allow, ctrl.getCrop);
// מה שהורים סימנו וממתין לאישור צוות. תג של הורה נספר אצלו מיד, אבל הוא לא
// הופך לתמונת ייחוס עד שמישהי מהגן מאשרת — הורה שלחץ על הפרצוף הלא נכון היה
// מלמד את המערכת ילד של משפחה אחרת, שיטתית.
router.get('/parent-claims', allow, ctrl.getParentClaims);
router.post('/parent-claims/:photoId/:faceIndex', allow, ctrl.resolveClaim);

router.post('/:photoId/:faceIndex', allow, ctrl.decide);

module.exports = router;
