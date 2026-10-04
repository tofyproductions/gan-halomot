const svc = require('../services/shifts/shiftWeek.service');
const cs = require('../services/shifts/constraints.service');
const { resolveSelfEmployee } = require('./payroll.controller');
const { weekStart: sundayOf } = require('../services/parentVisibility');
const { todayIsrael } = require('../services/fixedSchedule');

/** Service errors carry their own status; everything else is a 500 via next(). */
const handle = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof svc.ShiftError) return res.status(err.status).json({ error: err.message, ...err.extra });
    return next(err);
  }
};

const weekParam = (v) => (v ? String(v) : sundayOf(todayIsrael()));

module.exports = {
  board: handle(async (req, res) => {
    res.json(await svc.getBoard({ user: req.user, branchId: String(req.query.branch || ''), weekStart: weekParam(req.query.week) }));
  }),
  createWeek: handle(async (req, res) => {
    res.json({ week: await svc.createWeek({ user: req.user, branchId: String(req.body.branch || ''), weekStart: String(req.body.week || '') }) });
  }),
  saveEntries: handle(async (req, res) => {
    res.json({ week: await svc.saveEntries({ user: req.user, weekId: req.params.id, entries: req.body.entries }) });
  }),
  closedDay: handle(async (req, res) => {
    res.json({ week: await svc.setClosedDay({ user: req.user, weekId: req.params.id, date: String(req.body.date || ''), closed: req.body.closed === true }) });
  }),
  publish: handle(async (req, res) => {
    res.json(await svc.publishWeek({ user: req.user, weekId: req.params.id }));
  }),
  createEditRequest: handle(async (req, res) => {
    res.json({ request: await svc.createEditRequest({ user: req.user, weekId: req.params.id, entries: req.body.entries }) });
  }),
  decideEditRequest: handle(async (req, res) => {
    res.json({ request: await svc.decideEditRequest({ user: req.user, requestId: req.params.id, approve: req.body.approve === true, reason: req.body.reason }) });
  }),
  primaryClass: handle(async (req, res) => {
    await svc.setPrimaryClassroom({ user: req.user, employeeId: String(req.body.employee_id || ''), classroomId: String(req.body.classroom_id || '') });
    res.json({ ok: true });
  }),
  closeClassroom: handle(async (req, res) => { await svc.closeClassroom({ user: req.user, classroomId: req.params.id }); res.json({ ok: true }); }),
  reopenClassroom: handle(async (req, res) => { await svc.reopenClassroom({ user: req.user, classroomId: req.params.id }); res.json({ ok: true }); }),
  ratios: handle(async (req, res) => { await svc.setRatios({ user: req.user, branchId: req.params.branchId, ratios: req.body }); res.json({ ok: true }); }),
  my: handle(async (req, res) => {
    const employee = await resolveSelfEmployee(req);
    if (!employee) return res.json({ reason: 'no_employee' });
    res.json(await svc.myShifts({ employee, weekStart: weekParam(req.query.week) }));
  }),
  // ── אילוצים: employee side ─────────────────────────────────────────
  createConstraint: handle(async (req, res) => {
    const employee = await resolveSelfEmployee(req);
    if (!employee) return res.status(400).json({ error: 'לא נמצא כרטיס עובדת מקושר' });
    res.json({ constraint: await cs.createConstraint({ employee, body: req.body, files: req.files || [] }) });
  }),
  myConstraints: handle(async (req, res) => {
    const employee = await resolveSelfEmployee(req);
    if (!employee) return res.json({ reason: 'no_employee', mine: [], incoming: [], offers: [] });
    res.json(await cs.listMine({ employee }));
  }),
  colleagues: handle(async (req, res) => {
    const employee = await resolveSelfEmployee(req);
    res.json({ colleagues: employee ? await cs.colleaguesOf({ employee }) : [] });
  }),
  cancelConstraint: handle(async (req, res) => {
    const employee = await resolveSelfEmployee(req);
    if (!employee) return res.status(400).json({ error: 'לא נמצא כרטיס עובדת מקושר' });
    res.json(await cs.cancelConstraint({ employee, id: req.params.id }));
  }),
  colleagueResponse: handle(async (req, res) => {
    const employee = await resolveSelfEmployee(req);
    if (!employee) return res.status(400).json({ error: 'לא נמצא כרטיס עובדת מקושר' });
    res.json({ constraint: await cs.respondColleague({ employee, id: req.params.id, accept: req.body.accept === true }) });
  }),
  volunteer: handle(async (req, res) => {
    const employee = await resolveSelfEmployee(req);
    if (!employee) return res.status(400).json({ error: 'לא נמצא כרטיס עובדת מקושר' });
    res.json(await cs.volunteer({ employee, id: req.params.id }));
  }),
  // ── אילוצים: manager side ──────────────────────────────────────────
  futureConstraints: handle(async (req, res) => {
    res.json({ constraints: await cs.listFuture({ user: req.user, branchId: String(req.query.branch || '') }) });
  }),
  decideConstraint: handle(async (req, res) => {
    res.json({ constraint: await cs.decide({ user: req.user, id: req.params.id, accept: req.body.accept === true, reason: req.body.reason, confirmFar: req.body.confirm_far === true }) });
  }),
  approveBroadcast: handle(async (req, res) => {
    res.json({ constraint: await cs.approveBroadcast({ user: req.user, id: req.params.id }) });
  }),
  pickVolunteer: handle(async (req, res) => {
    res.json({ constraint: await cs.pickVolunteer({ user: req.user, id: req.params.id, employeeId: String(req.body.employee_id || '') }) });
  }),
  constraintFile: handle(async (req, res) => {
    const employee = await resolveSelfEmployee(req).catch(() => null);
    const f = await cs.readFile({ user: req.user, employee, id: req.params.id, index: req.params.index });
    res.setHeader('Content-Type', f.mimetype || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    res.send(f.buffer);
  }),
};
