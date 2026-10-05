/**
 * What the brain may know — and nothing more.
 *
 * Every function here returns a closed, hand-listed shape. Rows are NEVER
 * spread from a model document: a field the brain should not see (phone, email,
 * ת.ז, address, notes, bank details, salaries) must be impossible to leak by
 * someone adding a column to Child or Registration next year.
 *
 * The money arithmetic is not redone here. buildRegistrationMonths is the one
 * place that knows about proration, a fee that changed in March, discounts and
 * fee overrides — the staff table and the parent portal both use it, and a
 * third answer to "what does this child owe" would drift on the first discount
 * nobody remembered to copy across.
 */
const { Registration, Classroom, Child, Collection, Branch, Discount } = require('../models');
const { academicYearOf } = require('./academic-year.service');
const { buildRegistrationMonths } = require('./collection-view.service');

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const MIN_YEAR = 2020;
const MAX_YEAR = 2040;
const NO_CLASS = 'ללא קבוצה';

/** 'YYYY-MM' → { year, month, academicYear } or null when invalid / out of range. */
function parseMonth(raw) {
  const m = MONTH_RE.exec(String(raw || ''));
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (year < MIN_YEAR || year > MAX_YEAR) return null;
  // The gan year runs September → August: Oct 2026 belongs to 2026-2027,
  // March 2027 to 2026-2027 as well.
  const startYear = month >= 9 ? year : year - 1;
  return { year, month, academicYear: `${startYear}-${startYear + 1}` };
}

/** The current month in Israel, as 'YYYY-MM'. */
function currentMonthKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit' })
    .formatToParts(now);
  const y = parts.find(p => p.type === 'year').value;
  const mo = parts.find(p => p.type === 'month').value;
  return `${y}-${mo}`;
}

/** "דנה כהן לוי" → "דנה ל׳" — first name + last initial, never the full name. */
function shortName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${Array.from(parts[parts.length - 1])[0]}.`;
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function nameMaps() {
  const [branches, classrooms] = await Promise.all([
    Branch.find({}, 'name').lean(),
    Classroom.find({}, 'name branch_id').lean(),
  ]);
  return {
    branchName: new Map(branches.map(b => [String(b._id), b.name])),
    classroomById: new Map(classrooms.map(c => [String(c._id), c])),
  };
}

/** One row per registration for `month`, in the closed brain shape. */
async function paymentRows(month) {
  const parsed = typeof month === 'string' ? parseMonth(month) : month;
  const { academicYear, month: monthNum } = parsed;

  // Same population as the collections screen: completed registrations, those
  // with a live child, and cancelled ones still settling their debt.
  const activeChildren = await Child.find({ is_active: true }, 'registration_id').lean();
  const registrations = await Registration.find({
    $or: [
      { status: 'completed' },
      { _id: { $in: activeChildren.map(c => c.registration_id) } },
      { status: 'cancelled', billing_settled: { $ne: true } },
    ],
  }).lean();
  const regs = registrations.filter(r => academicYearOf(r) === academicYear);

  const regIds = regs.map(r => r._id);
  const [collections, discounts, maps] = await Promise.all([
    Collection.find({ registration_id: { $in: regIds }, academic_year: academicYear }).lean(),
    Discount.find({ is_active: true, academic_year: academicYear }).lean(),
    nameMaps(),
  ]);
  const collectionByReg = new Map(collections.map(c => [String(c.registration_id), c]));

  const rows = [];
  for (const reg of regs) {
    const { months } = buildRegistrationMonths({
      reg, academicYear, collection: collectionByReg.get(String(reg._id)) || null, discounts,
    });
    const cell = months.find(m => m.month === monthNum);
    if (!cell) continue;

    const due = round2(cell.expected_amount);
    const paid = round2(cell.paid_amount);
    let status;
    if (cell.payment_status === 'exempt') status = 'exempt';
    else if (due <= 0) status = 'none';            // before start / after exit / free month
    else if (paid >= due) status = 'paid';
    else if (paid > 0) status = 'partial';
    else status = 'unpaid';

    const classroom = maps.classroomById.get(String(reg.classroom_id)) || null;
    const branchId = reg.branch_id || classroom?.branch_id || null;
    rows.push({
      child: shortName(reg.child_name),
      class: classroom?.name || NO_CLASS,
      branch: maps.branchName.get(String(branchId)) || null,
      due, paid, status,
    });
  }
  return rows.sort((a, b) => a.branch?.localeCompare(b.branch || '') || a.class.localeCompare(b.class) || a.child.localeCompare(b.child));
}

async function payments(month) {
  const parsed = parseMonth(month);
  const rows = await paymentRows(parsed);
  return { month, count: rows.length, payments: rows };
}

async function unpaid(month) {
  const parsed = parseMonth(month);
  const rows = (await paymentRows(parsed)).filter(r => r.status === 'unpaid' || r.status === 'partial');
  return {
    month,
    count: rows.length,
    total_outstanding: round2(rows.reduce((s, r) => s + (r.due - r.paid), 0)),
    unpaid: rows,
  };
}

async function children({ active = true } = {}) {
  const kids = await Child.find({ is_active: active }, 'child_name classroom_id registration_id').lean();
  const [regs, maps] = await Promise.all([
    Registration.find({ _id: { $in: kids.map(k => k.registration_id) } }, 'start_date branch_id').lean(),
    nameMaps(),
  ]);
  const regById = new Map(regs.map(r => [String(r._id), r]));
  const rows = kids.map((k) => {
    const reg = regById.get(String(k.registration_id));
    const classroom = maps.classroomById.get(String(k.classroom_id)) || null;
    const branchId = classroom?.branch_id || reg?.branch_id || null;
    return {
      child: shortName(k.child_name),
      class: classroom?.name || NO_CLASS,
      branch: maps.branchName.get(String(branchId)) || null,
      start_date: reg?.start_date ? reg.start_date.toISOString().slice(0, 10) : null,
    };
  });
  rows.sort((a, b) => a.branch?.localeCompare(b.branch || '') || a.class.localeCompare(b.class) || a.child.localeCompare(b.child));
  return { count: rows.length, children: rows };
}

async function summary(now = new Date()) {
  const monthKey = currentMonthKey(now);
  const [kids, maps, rows] = await Promise.all([
    Child.find({ is_active: true }, 'classroom_id').lean(),
    nameMaps(),
    paymentRows(parseMonth(monthKey)),
  ]);

  const tally = new Map();
  for (const k of kids) {
    const classroom = maps.classroomById.get(String(k.classroom_id)) || null;
    const branch = maps.branchName.get(String(classroom?.branch_id)) || null;
    const cls = classroom?.name || NO_CLASS;
    const key = `${branch}\u0000${cls}`;
    const t = tally.get(key) || { branch, class: cls, active_children: 0 };
    t.active_children += 1;
    tally.set(key, t);
  }
  const byClass = [...tally.values()].sort((a, b) => String(a.branch).localeCompare(String(b.branch)) || a.class.localeCompare(b.class));
  const byBranch = new Map();
  for (const t of byClass) byBranch.set(t.branch, (byBranch.get(t.branch) || 0) + t.active_children);

  return {
    active_children_total: kids.length,
    active_children_by_branch: [...byBranch].map(([branch, active_children]) => ({ branch, active_children })),
    active_children_by_class: byClass,
    current_month: {
      month: monthKey,
      expected: round2(rows.reduce((s, r) => s + r.due, 0)),
      collected: round2(rows.reduce((s, r) => s + Math.min(r.paid, r.due), 0)),
    },
  };
}

module.exports = { parseMonth, currentMonthKey, shortName, summary, payments, unpaid, children };
