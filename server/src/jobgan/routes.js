const express = require('express');
const rateLimit = require('express-rate-limit');

const auth = require('./auth');
const board = require('./controllers/board.controller');
const employer = require('./controllers/employer.controller');
const seeker = require('./controllers/seeker.controller');
const application = require('./controllers/application.controller');
const admin = require('./controllers/admin.controller');

const router = express.Router();

/**
 * Rate limits on every door that takes a password or creates an account.
 *
 * This service is public and advertised — its login page is reachable by
 * anyone who follows a campaign link. Without a ceiling, the sign-in form is
 * an offer to guess passwords at machine speed, and the sign-up form is an
 * offer to fill the database.
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'יותר מדי ניסיונות. יש להמתין ולנסות שוב.' },
});

const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'יותר מדי הרשמות מכתובת זו. יש להמתין ולנסות שוב.' },
});

const applyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'יותר מדי מועמדויות בשעה האחרונה.' },
});

// ---------- public: the board ----------
router.get('/meta', board.meta);
router.get('/jobs', board.list);
router.get('/jobs/counts', board.counts);
router.get('/jobs/:id', board.one);

// ---------- seekers ----------
router.post('/seekers/register', signupLimiter, seeker.register);
router.post('/seekers/login', loginLimiter, seeker.login);
router.get('/seekers/me', auth.requireSeeker, seeker.me);
router.patch('/seekers/me', auth.requireSeeker, seeker.updateMe);
router.delete('/seekers/me', auth.requireSeeker, seeker.deleteMe);
router.get('/seekers/me/applications', auth.requireSeeker, application.mine);
router.post('/jobs/:jobId/apply', applyLimiter, auth.requireSeeker, application.apply);

// ---------- employers ----------
router.post('/employers/register', signupLimiter, employer.register);
router.post('/employers/login', loginLimiter, employer.login);
router.get('/employers/me', auth.requireEmployer, employer.me);
router.post('/employers/jobs', auth.requireEmployer, employer.createJob);
router.get('/employers/jobs', auth.requireEmployer, employer.myJobs);
router.post('/employers/jobs/:id/close', auth.requireEmployer, employer.closeJob);
router.get('/employers/applications', auth.requireEmployer, application.forEmployer);
router.post('/employers/applications/:id/open', auth.requireEmployer, application.open);
router.post('/employers/applications/:id/answer', auth.requireEmployer, application.answer);

// ---------- us ----------
router.get('/admin/queue', auth.requireOperator, admin.queue);
router.post('/admin/jobs/:id/approve', auth.requireOperator, admin.approve);
router.post('/admin/jobs/:id/reject', auth.requireOperator, admin.reject);

module.exports = router;
