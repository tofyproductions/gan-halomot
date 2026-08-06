/**
 * הנפקת מסמכים לעובד — issue the fixed-wording HR letters.
 *
 * The manager never types the employee's identity: the server builds the merge
 * context from the employee card (name, ת"ז, position, branch, start date) and
 * computes seniority and the statutory notice period. She only supplies what
 * the system genuinely cannot know — the reasons, the meeting time, what the
 * employee said at the hearing.
 */
const { Employee, Branch, EmployeeLetter, User } = require('../models');
const letters = require('../services/employeeLetters');
const { htmlToPdf } = require('../services/htmlPdf');

/** Branch ids this user may act on, or null for "everything". */
function branchScopeOf(req) {
  const role = req.user?.role;
  if (role === 'system_admin' || role === 'accountant') return null;
  const managed = (req.user?.managed_branch_ids || []).map(String);
  const fallback = req.user?.branch_id ? [String(req.user.branch_id)] : [];
  return managed.length ? managed : fallback;
}

/** Load the employee and refuse one outside the caller's branches. */
async function loadEmployee(req, employeeId) {
  const emp = await Employee.findById(employeeId).lean();
  if (!emp) return { error: { status: 404, message: 'עובד לא נמצא' } };
  const scope = branchScopeOf(req);
  if (scope && !scope.map(String).includes(String(emp.branch_id))) {
    return { error: { status: 403, message: 'העובד/ת אינו/ה בסניף שבאחריותך' } };
  }
  const branch = emp.branch_id ? await Branch.findById(emp.branch_id).select('name').lean() : null;
  return { emp, branch };
}

/**
 * Who can be named as the issuer of a letter for this employee.
 *
 * The signature is a statement about who ran the process, not about who
 * happened to click the button: a hearing at משה דיין is conducted and signed
 * by that branch's manager, even when a system admin issues the paperwork from
 * the office. So the default is the branch's own manager, and an admin who
 * genuinely is the issuer picks themselves from the list.
 */
async function issuerOptions(emp, currentUser) {
  const branchId = emp.branch_id ? String(emp.branch_id) : null;
  const managers = branchId
    ? await User.find({
        role: 'branch_manager',
        is_active: true,
        $or: [{ managed_branch_ids: branchId }, { branch_id: branchId }],
      }).select('full_name role').sort({ full_name: 1 }).lean()
    : [];

  const options = managers.map(m => ({
    id: String(m._id), name: m.full_name, title: 'מנהל/ת המעון', is_branch_manager: true,
  }));
  // The caller is always selectable — but only as an explicit choice.
  if (currentUser?.id && !options.some(o => o.id === String(currentUser.id))) {
    options.push({
      id: String(currentUser.id),
      name: currentUser.full_name || '',
      title: currentUser.role === 'accountant' ? 'הנהלת חשבונות' : 'הנהלה',
      is_branch_manager: false,
    });
  }
  // A branch manager issuing for her own staff signs as herself; anyone else
  // defaults to the branch's manager and may override.
  const self = options.find(o => o.id === String(currentUser?.id));
  const preferred = (currentUser?.role === 'branch_manager' && self)
    ? self
    : (options.find(o => o.is_branch_manager) || self || options[0] || null);
  return { options, preferred };
}

/**
 * GET /api/employee-letters/context/:employeeId
 * Everything the letters will be filled with, before the manager edits it —
 * so the form opens pre-filled and she can see the computed notice period and
 * why it is that number before she commits to it.
 */
async function getContext(req, res, next) {
  try {
    const { emp, branch, error } = await loadEmployee(req, req.params.employeeId);
    if (error) return res.status(error.status).json({ error: error.message });
    const { options, preferred } = await issuerOptions(emp, req.user);
    const ctx = letters.buildContext(emp, {
      branch,
      issuer: req.user,
      overrides: preferred ? { issuer_name: preferred.name, issuer_title: preferred.title } : {},
    });
    res.json({
      context: ctx,
      issuers: options,
      default_issuer_id: preferred?.id || null,
      types: letters.LETTER_TYPES.map(t => ({ type: t, label: letters.LETTER_LABELS[t] })),
    });
  } catch (err) { next(err); }
}

/**
 * POST /api/employee-letters/preview  { employee_id, type, overrides }
 * The letter as HTML, without saving. The manager reads the real thing before
 * issuing it rather than trusting a form.
 */
async function preview(req, res, next) {
  try {
    const { employee_id, type, overrides } = req.body || {};
    if (!letters.LETTER_TYPES.includes(type)) return res.status(400).json({ error: 'סוג מסמך לא מוכר' });
    const { emp, branch, error } = await loadEmployee(req, employee_id);
    if (error) return res.status(error.status).json({ error: error.message });
    const { preferred } = await issuerOptions(emp, req.user);
    const ctx = letters.buildContext(emp, {
      branch,
      issuer: req.user,
      overrides: {
        ...(preferred ? { issuer_name: preferred.name, issuer_title: preferred.title } : {}),
        ...(overrides || {}),
      },
    });
    res.json({ html: letters.renderLetter(type, ctx, { preview: true }), context: ctx });
  } catch (err) { next(err); }
}

/**
 * POST /api/employee-letters  { employee_id, type, overrides }
 * Issue for real: render, snapshot the employee facts, and keep it.
 */
async function issue(req, res, next) {
  try {
    const { employee_id, type, overrides } = req.body || {};
    if (!letters.LETTER_TYPES.includes(type)) return res.status(400).json({ error: 'סוג מסמך לא מוכר' });
    const { emp, branch, error } = await loadEmployee(req, employee_id);
    if (error) return res.status(error.status).json({ error: error.message });

    const { preferred } = await issuerOptions(emp, req.user);
    const ctx = letters.buildContext(emp, {
      branch,
      issuer: req.user,
      overrides: {
        ...(preferred ? { issuer_name: preferred.name, issuer_title: preferred.title } : {}),
        ...(overrides || {}),
      },
    });

    // A hearing invitation with no reasons and no date is not a letter — it is
    // a blank the employee cannot answer, and the whole point of a שימוע is
    // that she knows what she is answering to.
    if (type === 'hearing_invite') {
      if (!String(ctx.reasons || '').trim()) return res.status(400).json({ error: 'יש לפרט את הסיבות לשימוע' });
      if (!ctx.hearing_date || !ctx.hearing_time) return res.status(400).json({ error: 'יש לקבוע תאריך ושעה לשימוע' });
    }
    if (type === 'termination' && !String(ctx.reasons || '').trim()) {
      return res.status(400).json({ error: 'יש לפרט את נימוקי סיום ההעסקה' });
    }

    const html = letters.renderLetter(type, ctx);
    const doc = await EmployeeLetter.create({
      employee_id: emp._id,
      branch_id: emp.branch_id || null,
      type,
      title: letters.LETTER_LABELS[type],
      html,
      fields: ctx,
      snapshot: {
        full_name: emp.full_name || '',
        israeli_id: emp.israeli_id || '',
        position: emp.position || '',
        branch_name: branch?.name || '',
        start_date: emp.start_date || null,
        seniority: ctx.seniority,
        notice_days: ctx.notice_days,
      },
      issued_by: req.user?.id || null,
      issued_by_name: req.user?.full_name || '',
      signed_by_name: ctx.issuer_name || '',
      signed_by_title: ctx.issuer_title || '',
    });
    res.status(201).json({ letter: { ...doc.toObject(), html: undefined, id: doc._id } });
  } catch (err) { next(err); }
}

/** GET /api/employee-letters?employee_id= — what was issued, newest first. */
async function list(req, res, next) {
  try {
    const filter = {};
    if (req.query.employee_id) filter.employee_id = req.query.employee_id;
    const scope = branchScopeOf(req);
    if (scope) filter.branch_id = { $in: scope };
    const docs = await EmployeeLetter.find(filter)
      .select('-html -fields')
      .sort({ created_at: -1 })
      .limit(200)
      .lean();
    res.json({ letters: docs.map(d => ({ ...d, id: String(d._id) })) });
  } catch (err) { next(err); }
}

/** GET /api/employee-letters/:id — the stored letter, exactly as issued. */
async function getOne(req, res, next) {
  try {
    const doc = await EmployeeLetter.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'מסמך לא נמצא' });
    const scope = branchScopeOf(req);
    if (scope && !scope.map(String).includes(String(doc.branch_id))) {
      return res.status(403).json({ error: 'אין הרשאה למסמך זה' });
    }
    res.json({ letter: { ...doc, id: String(doc._id) } });
  } catch (err) { next(err); }
}

/**
 * GET /api/employee-letters/:id/pdf
 * Rendered from the STORED html, so the PDF can never drift from the letter
 * that was issued. If Chromium can't launch (memory), fall back to serving the
 * HTML — the manager still gets a printable document rather than an error.
 */
async function pdf(req, res, next) {
  try {
    const doc = await EmployeeLetter.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'מסמך לא נמצא' });
    const scope = branchScopeOf(req);
    if (scope && !scope.map(String).includes(String(doc.branch_id))) {
      return res.status(403).json({ error: 'אין הרשאה למסמך זה' });
    }
    const name = `${doc.title} - ${doc.snapshot?.full_name || ''}`.trim().replace(/[/\\?%*:|"<>]/g, '-');
    try {
      const buf = await htmlToPdf(doc.html);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(name)}.pdf`);
      return res.send(buf);
    } catch (e) {
      console.error('[employeeLetters] PDF render failed, serving HTML:', e.message);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(doc.html);
    }
  } catch (err) { next(err); }
}

/** DELETE /api/employee-letters/:id — issued by mistake. Accounting/admin only. */
async function remove(req, res, next) {
  try {
    const role = req.user?.role;
    if (role !== 'system_admin' && role !== 'accountant') {
      return res.status(403).json({ error: 'רק הנהלת חשבונות או מנהל מערכת יכולים למחוק מסמך שהונפק' });
    }
    await EmployeeLetter.deleteOne({ _id: req.params.id });
    res.json({ ok: true });
  } catch (err) { next(err); }
}

module.exports = { getContext, preview, issue, list, getOne, pdf, remove };
