/**
 * הנפקת מסמכים להורים — אישור שהות בגן ואישור קייטנת אוגוסט.
 *
 * Mirrors employeeLetters.controller: the office never types the child's
 * identity — the server builds the merge context from the child card, the
 * registration and the branch's amuta — and the amounts come from the same
 * derivation the collections screen shows, not from a human's memory.
 */
const {
  Child, Registration, Branch, Amuta, Collection, Discount, SummerCamp, ParentLetter,
} = require('../models');
const letters = require('../services/parentLetters');
const { htmlToPdf } = require('../services/htmlPdf');
const letterhead = require('../services/letterhead');
const { buildRegistrationMonths } = require('../services/collection-view.service');
const { resolveBranchScope, canAccessBranch } = require('../utils/branch-scope');

/** Load the child + registration, refusing one outside the caller's branches. */
async function loadChild(req, childId) {
  const child = await Child.findById(childId).lean();
  if (!child) return { error: { status: 404, message: 'ילד/ה לא נמצא/ה' } };
  const reg = child.registration_id
    ? await Registration.findById(child.registration_id).lean()
    : null;
  const branchId = reg?.branch_id || null;
  if (branchId && !(await canAccessBranch(req, branchId))) {
    return { error: { status: 403, message: 'הילד/ה אינו/ה בסניף שבאחריותך' } };
  }
  const branch = branchId ? await Branch.findById(branchId).lean() : null;
  const amuta = branch?.amuta_id ? await Amuta.findById(branch.amuta_id).lean() : null;
  return { child, reg, branch, amuta };
}

/**
 * What the family actually paid this year, from the same derivation the
 * collections screen uses. Summing the stored paid_amount instead would
 * understate it — the builder marks a month paid off its receipt.
 */
async function paymentSummary(reg, academicYear) {
  if (!reg || !academicYear) return {};
  try {
    const [collection, discounts, camp] = await Promise.all([
      Collection.findOne({ registration_id: reg._id, academic_year: academicYear }).lean(),
      Discount.find({ is_active: true, branch_id: reg.branch_id }).lean(),
      reg.branch_id
        ? SummerCamp.findOne({ branch_id: reg.branch_id, academic_year: academicYear, enabled: true }).lean()
        : null,
    ]);
    const built = buildRegistrationMonths({
      reg, academicYear, collection: collection || null, discounts, camp: camp || null, siblings: [],
    });
    const billable = (built.months || []).filter(m => !m.is_before_start && m.expected_amount > 0);
    const total_paid = billable
      .filter(m => ['paid', 'partial'].includes(m.payment_status) || m.receipt_number)
      .reduce((s, m) => s + (m.paid_amount || 0), 0);
    const camp_paid = built.campCell && built.campCell.camp_enrolled
      ? (built.campCell.paid_amount || built.campCell.expected_amount || null)
      : null;
    return { total_paid: total_paid || null, camp_paid };
  } catch (e) {
    // A letter without pre-filled sums beats no letter — the office can type them.
    console.error('[parent-letters] payment summary failed:', e.message);
    return {};
  }
}

/** GET /api/parent-letters/context/:childId — the pre-filled merge context. */
async function getContext(req, res, next) {
  try {
    const { child, reg, branch, amuta, error } = await loadChild(req, req.params.childId);
    if (error) return res.status(error.status).json({ error: error.message });
    const payments = await paymentSummary(reg, child.academic_year || reg?.academic_year);
    const ctx = letters.buildContext({
      child, registration: reg, branch, amuta,
      issuer: { full_name: req.user?.full_name || '', role: req.user?.role },
      payments,
    });
    res.json({ context: ctx, letter_labels: letters.LETTER_LABELS });
  } catch (err) { next(err); }
}

/** POST /api/parent-letters/preview  { child_id, letter_type, overrides } */
async function preview(req, res, next) {
  try {
    const { child, reg, branch, amuta, error } = await loadChild(req, req.body?.child_id);
    if (error) return res.status(error.status).json({ error: error.message });
    if (!letters.LETTER_TYPES.includes(req.body?.letter_type)) {
      return res.status(400).json({ error: 'סוג מסמך לא מוכר' });
    }
    const payments = await paymentSummary(reg, child.academic_year || reg?.academic_year);
    const ctx = letters.buildContext({
      child, registration: reg, branch, amuta,
      issuer: { full_name: req.user?.full_name || '', role: req.user?.role },
      payments,
      overrides: req.body?.overrides || {},
    });
    const html = letterhead.inject(letters.renderLetter(req.body.letter_type, ctx, { preview: true }));
    res.json({ html });
  } catch (err) { next(err); }
}

/** POST /api/parent-letters  { child_id, letter_type, overrides } — issue and freeze. */
async function issue(req, res, next) {
  try {
    const { child, reg, branch, amuta, error } = await loadChild(req, req.body?.child_id);
    if (error) return res.status(error.status).json({ error: error.message });
    if (!letters.LETTER_TYPES.includes(req.body?.letter_type)) {
      return res.status(400).json({ error: 'סוג מסמך לא מוכר' });
    }
    const payments = await paymentSummary(reg, child.academic_year || reg?.academic_year);
    const ctx = letters.buildContext({
      child, registration: reg, branch, amuta,
      issuer: { full_name: req.user?.full_name || '', role: req.user?.role },
      payments,
      overrides: req.body?.overrides || {},
    });
    const html = letters.renderLetter(req.body.letter_type, ctx);
    const doc = await ParentLetter.create({
      child_id: child._id,
      registration_id: reg?._id || null,
      branch_id: reg?.branch_id || null,
      letter_type: req.body.letter_type,
      html,
      fields: ctx,
      snapshot: {
        child_name: ctx.child_name,
        parent_name: ctx.parent_name,
        branch_name: ctx.branch_name,
        academic_year: ctx.academic_year,
      },
      issued_by: req.user?.id || null,
      signed_by_name: ctx.issuer_name,
    });
    res.status(201).json({ id: String(doc._id) });
  } catch (err) { next(err); }
}

/** GET /api/parent-letters — recent history, branch-scoped. */
async function list(req, res, next) {
  try {
    const scope = await resolveBranchScope(req);
    const filter = scope === null ? {} : { branch_id: { $in: scope } };
    const rows = await ParentLetter.find(filter)
      .select('-html -fields')
      .sort({ created_at: -1 })
      .limit(100)
      .lean();
    res.json({
      letters: rows.map(r => ({
        id: String(r._id),
        letter_type: r.letter_type,
        type_label: letters.LETTER_LABELS[r.letter_type] || r.letter_type,
        child_name: r.snapshot?.child_name || '',
        parent_name: r.snapshot?.parent_name || '',
        branch_name: r.snapshot?.branch_name || '',
        academic_year: r.snapshot?.academic_year || '',
        signed_by_name: r.signed_by_name,
        created_at: r.created_at,
      })),
      letter_labels: letters.LETTER_LABELS,
    });
  } catch (err) { next(err); }
}

/** The stored letter, if its branch is in the caller's scope. */
async function loadLetter(req, id) {
  const doc = await ParentLetter.findById(id).lean();
  if (!doc) return { error: { status: 404, message: 'מסמך לא נמצא' } };
  if (doc.branch_id && !(await canAccessBranch(req, doc.branch_id))) {
    return { error: { status: 403, message: 'המסמך שייך לסניף שאינו באחריותך' } };
  }
  return { doc };
}

/** GET /api/parent-letters/:id/pdf — render the FROZEN html. */
async function pdf(req, res, next) {
  try {
    const { doc, error } = await loadLetter(req, req.params.id);
    if (error) return res.status(error.status).json({ error: error.message });
    const html = letterhead.inject(doc.html);
    const filename = `${doc.snapshot?.child_name || 'מסמך'} - ${letters.LETTER_LABELS[doc.letter_type] || ''}`.trim();
    try {
      const buf = await htmlToPdf(html);
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(`${filename}.pdf`)}`,
      });
      return res.send(buf);
    } catch (e) {
      // Chromium unavailable — the HTML prints the same page.
      console.error('[parent-letters] pdf render failed, serving html:', e.message);
      res.set({ 'Content-Type': 'text/html; charset=utf-8' });
      return res.send(html);
    }
  } catch (err) { next(err); }
}

/** DELETE /api/parent-letters/:id — office only, for a letter issued in error. */
async function remove(req, res, next) {
  try {
    const { doc, error } = await loadLetter(req, req.params.id);
    if (error) return res.status(error.status).json({ error: error.message });
    await ParentLetter.deleteOne({ _id: doc._id });
    res.json({ ok: true });
  } catch (err) { next(err); }
}

module.exports = { getContext, preview, issue, list, pdf, remove };
