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
const { Registration, Classroom, Child, Collection, Branch, Discount, IncomeAllocation, FinanceSyncLog, BankAccount, Absence, Order, Supplier, ShiftWeek, Holiday, SpecialDay, ParentAccount } = require('../models');
const { academicYearOf } = require('./academic-year.service');
const { buildRegistrationMonths } = require('./collection-view.service');
const { closureDateSet } = require('./fixedSchedule');
const { CATEGORY_KEY, effectiveRatios } = require('./shifts/ratio');

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const MIN_YEAR = 2020;
const MAX_YEAR = 2040;
const NO_CLASS = 'ללא קבוצה';
// The app has no per-gan "payment due day" setting, so a month counts as
// overdue from the 11th of that month (due by the 10th). Assumption, one place.
const DUE_DAY = 10;
// Registration fields the brain reads. Everything else — parent_phone,
// parent_email, parent_id_number, parent_name, signature_data — is not even
// loaded from the database.
const REG_FIELDS = 'branch_id child_name classroom_id monthly_fee previous_monthly_fee fee_effective_from start_date end_date academic_year status billing_settled';
const cmp = (a, b) => String(a ?? '').localeCompare(String(b ?? ''));
const byBranchClassChild = (a, b) => cmp(a.branch, b.branch) || cmp(a.class, b.class) || cmp(a.child, b.child);

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

/** Today in Israel: { key: 'YYYY-MM', day }. */
function israelToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now);
  const get = (t) => parts.find(p => p.type === t).value;
  return { key: `${get('year')}-${get('month')}`, day: Number(get('day')) };
}
const currentMonthKey = (now = new Date()) => israelToday(now).key;

/** 'past' | 'current' | 'future' for a 'YYYY-MM', in Israel time (keys sort as strings). */
function monthState(monthKey, now = new Date()) {
  const cur = currentMonthKey(now);
  return monthKey < cur ? 'past' : monthKey > cur ? 'future' : 'current';
}

/** Is the due day behind us? Past months yes, future no, current after DUE_DAY. */
function duePassed(monthKey, now = new Date()) {
  const st = monthState(monthKey, now);
  return st === 'past' || (st === 'current' && israelToday(now).day > DUE_DAY);
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
    Classroom.find({}, 'name branch_id category').lean(),
  ]);
  return {
    branchName: new Map(branches.map(b => [String(b._id), b.name])),
    classroomById: new Map(classrooms.map(c => [String(c._id), c])),
  };
}

/** One row per registration for `month`, in the closed brain shape. */
async function paymentRows(monthKey, now = new Date()) {
  const { academicYear, month: monthNum } = parseMonth(monthKey);
  const passed = duePassed(monthKey, now);

  // Same population as the collections screen: completed registrations, those
  // with a live child, and cancelled ones still settling their debt.
  const activeChildren = await Child.find({ is_active: true }, 'registration_id').lean();
  const registrations = await Registration.find({
    $or: [
      { status: 'completed' },
      { _id: { $in: activeChildren.map(c => c.registration_id) } },
      { status: 'cancelled', billing_settled: { $ne: true } },
    ],
  }, REG_FIELDS).lean();
  const regs = registrations.filter(r => academicYearOf(r) === academicYear);

  const regIds = regs.map(r => r._id);
  const [collections, discounts, maps, allocRows] = await Promise.all([
    Collection.find({ registration_id: { $in: regIds }, academic_year: academicYear }).lean(),
    Discount.find({ is_active: true, academic_year: academicYear }).lean(),
    nameMaps(),
    // Bank transfers matched to a child in the income module — the same source
    // collections.controller reads as `bank_allocated`.
    IncomeAllocation.aggregate([
      { $match: { registration_id: { $in: regIds }, academic_year: academicYear, month_number: monthNum } },
      { $group: { _id: '$registration_id', total: { $sum: '$amount' } } },
    ]),
  ]);
  const bankByReg = new Map(allocRows.map(a => [String(a._id), round2(a.total)]));
  const collectionByReg = new Map(collections.map(c => [String(c.registration_id), c]));

  const rows = [];
  for (const reg of regs) {
    const classroom = maps.classroomById.get(String(reg.classroom_id)) || null;
    const branchId = reg.branch_id || classroom?.branch_id || null;
    // The shared service applies EVERY scope:'branch' discount to every child
    // handed to it, never comparing the discount's branch (the staff screen is
    // filtered per branch upstream; this system-wide read is not). So the list
    // is narrowed here, per registration, to its own branch's branch-wide
    // discounts plus the child/classroom ones, which match by id anyway.
    const regDiscounts = discounts.filter(d => d.scope !== 'branch' || String(d.branch_id) === String(branchId));
    const { months } = buildRegistrationMonths({
      reg, academicYear, collection: collectionByReg.get(String(reg._id)) || null, discounts: regDiscounts,
    });
    const cell = months.find(m => m.month === monthNum);
    if (!cell) continue;

    const due = round2(cell.expected_amount);
    const paid = round2(cell.paid_amount);
    const bank = bankByReg.get(String(reg._id)) || 0;
    let status;
    if (cell.payment_status === 'exempt') status = 'exempt';
    else if (due <= 0) status = 'none';            // before start / after exit / free month
    else if (paid >= due) status = 'paid';
    else if (bank >= due - paid) status = 'paid_by_bank'; // not on the card yet, but the bank shows it
    else if (paid > 0) status = 'partial';
    else status = 'unpaid';

    rows.push({
      child: shortName(reg.child_name),
      class: classroom?.name || NO_CLASS,
      branch: maps.branchName.get(String(branchId)) || null,
      due, paid, bank_found: bank, status, due_passed: passed,
    });
  }
  return rows.sort(byBranchClassChild);
}

async function payments(month, now = new Date()) {
  const rows = await paymentRows(month, now);
  return { month, month_state: monthState(month, now), count: rows.length, payments: rows };
}

async function unpaid(month, now = new Date()) {
  const rows = (await paymentRows(month, now)).filter(r => r.status === 'unpaid' || r.status === 'partial');
  return {
    month,
    month_state: monthState(month, now),
    count: rows.length,
    total_outstanding: round2(rows.reduce((s, r) => s + (r.due - r.paid), 0)),
    unpaid: rows,
  };
}

/** Active children only — the brain has no use for the departed. */
async function children() {
  const kids = await Child.find({ is_active: true }, 'child_name classroom_id registration_id').lean();
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
  rows.sort(byBranchClassChild);
  return { count: rows.length, children: rows };
}

async function summary(now = new Date()) {
  const monthKey = currentMonthKey(now);
  const [kids, maps, rows] = await Promise.all([
    Child.find({ is_active: true }, 'classroom_id').lean(),
    nameMaps(),
    paymentRows(monthKey, now),
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
  const byClass = [...tally.values()].sort((a, b) => cmp(a.branch, b.branch) || cmp(a.class, b.class));
  const byBranch = new Map();
  for (const t of byClass) byBranch.set(t.branch, (byBranch.get(t.branch) || 0) + t.active_children);

  return {
    active_children_total: kids.length,
    active_children_by_branch: [...byBranch].map(([branch, active_children]) => ({ branch, active_children })),
    active_children_by_class: byClass,
    current_month: {
      month: monthKey,
      month_state: 'current',
      due_passed: duePassed(monthKey, now),
      expected: round2(rows.reduce((s, r) => s + r.due, 0)),
      collected: round2(rows.reduce((s, r) => s + Math.min(r.paid, r.due), 0)),
      bank_found_total: round2(rows.reduce((s, r) => s + r.bank_found, 0)),
    },
  };
}

/**
 * When the Pi last delivered bank data. Same definition the bank-watch job and
 * the finance screen use: the newest FinanceSyncLog row from the agent with
 * status ok (failed runs and manual xlsx uploads do not count). Returns only a
 * timestamp and a count — no account numbers, labels, balances or amounts.
 */
async function sync() {
  const [last, accounts] = await Promise.all([
    FinanceSyncLog.findOne({ source: 'agent', status: 'ok' }).sort({ created_at: -1 }).select('created_at').lean(),
    BankAccount.countDocuments({ type: 'bank', is_active: true }),
  ]);
  return {
    lastSyncAt: last?.created_at ? new Date(last.created_at).toISOString() : null,
    source: 'FinanceSyncLog: latest agent run with status ok',
    accounts,
  };
}



// ─────────────────────────────────────────────────────────────────────────────
// The morning report's reads (המוח: docs/business-data.md in hamoach) — the
// same rules as everything above: closed shapes, short names, no contact
// details, no ids, no notes; test families (Child.is_test_account) left out
// of every count, as the parent-signups screen does. System-wide like the rest
// of the brain window, with the branch named on every row.
// ─────────────────────────────────────────────────────────────────────────────

const DATE_RE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const DAY_MS = 86400000;
/** 'YYYY-MM-DD' within the brain's years, and a real calendar day; else null. */
function parseDate(raw) {
  const m = DATE_RE.exec(String(raw || ''));
  if (!m) return null;
  const y = Number(m[1]);
  if (y < MIN_YEAR || y > MAX_YEAR) return null;
  const d = new Date(`${raw}T12:00:00Z`);
  return d.toISOString().slice(0, 10) === raw ? raw : null;
}
const todayKey = (now = new Date()) => now.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const sundayOf = (ymd) => addDays(ymd, -new Date(`${ymd}T12:00:00Z`).getUTCDay());
const firstName = (full) => String(full || '').trim().split(/\s+/)[0] || '';
const realChildren = (extra = {}) => ({ is_active: true, is_test_account: { $ne: true }, ...extra });

/** Branch ids whose gan is fully closed on `date` (holiday closures + employer shut days). */
async function closedBranches(date) {
  const [holidays, specials] = await Promise.all([
    Holiday.find({ kind: 'closure', start_date: { $lte: new Date(`${date}T23:59:59+03:00`) }, end_date: { $gte: new Date(`${date}T00:00:00+03:00`) } }).lean(),
    SpecialDay.find({ date }).select('branch_id').lean(),
  ]);
  const out = new Set();
  for (const h of holidays) if (closureDateSet([h], h.branch_id).has(date)) out.add(String(h.branch_id));
  for (const s of specials) out.add(s.branch_id ? String(s.branch_id) : '*');
  return out;
}

/**
 * Who is expected in today, per class: the active children minus the absences
 * their parents reported for that day (cancelled reports do not count). A
 * branch closed that day expects nobody. What the staff then observe is
 * DailyLog's business, not this.
 */
async function attendance(date) {
  const [kids, maps, absences, closed] = await Promise.all([
    Child.find(realChildren(), 'classroom_id').lean(),
    nameMaps(),
    Absence.find({ date, cancelled_at: null }).select('child_id').lean(),
    closedBranches(date),
  ]);
  const absent = new Set(absences.map(a => String(a.child_id)));
  const tally = new Map();
  for (const k of kids) {
    const classroom = maps.classroomById.get(String(k.classroom_id)) || null;
    const branchId = classroom?.branch_id ? String(classroom.branch_id) : null;
    const key = `${branchId}\u0000${classroom?.name || NO_CLASS}`;
    const t = tally.get(key) || { branch_id: branchId, branch: maps.branchName.get(branchId) || null, class: classroom?.name || NO_CLASS, enrolled: 0, absent_reported: 0 };
    t.enrolled += 1;
    if (absent.has(String(k._id))) t.absent_reported += 1;
    tally.set(key, t);
  }
  const rows = [...tally.values()].map(({ branch_id: id, ...t }) => {
    const shut = closed.has('*') || (id && closed.has(id));
    return { ...t, closed: !!shut, expected: shut ? 0 : t.enrolled - t.absent_reported };
  }).sort((a, b) => cmp(a.branch, b.branch) || cmp(a.class, b.class));
  return { date, expected_total: rows.reduce((s, r) => s + r.expected, 0), by_class: rows };
}

/**
 * Orders the office has not approved yet (status awaiting_approval — the
 * supplier has not been told). Numbers, branch, supplier and size only: no
 * item lines, notes or names of who built it.
 */
async function pendingOrders() {
  const [orders, maps] = await Promise.all([
    Order.find({ status: 'awaiting_approval' }, 'order_number branch_id supplier_id submitted_at created_at items total_amount').sort({ submitted_at: 1, created_at: 1 }).lean(),
    nameMaps(),
  ]);
  const suppliers = new Map((await Supplier.find({ _id: { $in: orders.map(o => o.supplier_id) } }, 'name').lean()).map(s => [String(s._id), s.name]));
  const pending = orders.map(o => ({
    id_short: String(o.order_number || ''),
    branch: maps.branchName.get(String(o.branch_id)) || null,
    supplier: suppliers.get(String(o.supplier_id)) || null,
    created_at: (o.submitted_at || o.created_at) ? new Date(o.submitted_at || o.created_at).toISOString() : null,
    items_count: Array.isArray(o.items) ? o.items.length : 0,
    total: round2(o.total_amount),
  }));
  return { pending_count: pending.length, pending };
}

/**
 * Active children whose birthday falls in the next `days` days (today
 * included), soonest first. The date is the birthday's date THIS time round
 * (a 29 February birthday is kept on 28 February in a common year); the birth
 * date itself is what the record holds — the child's, or the registration's
 * when the child's is empty.
 */
async function birthdays(days, now = new Date()) {
  const from = todayKey(now);
  const to = addDays(from, days - 1);
  const [kids, maps] = await Promise.all([
    Child.find(realChildren(), 'child_name classroom_id birth_date registration_id').lean(),
    nameMaps(),
  ]);
  const regs = new Map((await Registration.find({ _id: { $in: kids.filter(k => !k.birth_date).map(k => k.registration_id) } }, 'child_birth_date').lean())
    .map(r => [String(r._id), r.child_birth_date]));
  const out = [];
  for (const k of kids) {
    const born = k.birth_date || regs.get(String(k.registration_id)) || null;
    if (!born) continue;
    const birth = new Date(born).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
    const [by, bm, bd] = birth.split('-').map(Number);
    for (const year of new Set([Number(from.slice(0, 4)), Number(to.slice(0, 4))])) {
      const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
      const day = bm === 2 && bd === 29 && !leap ? 28 : bd;
      const date = `${year}-${String(bm).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      if (date < from || date > to) continue;
      const classroom = maps.classroomById.get(String(k.classroom_id)) || null;
      out.push({
        child: shortName(k.child_name),
        class: classroom?.name || NO_CLASS,
        branch: maps.branchName.get(String(classroom?.branch_id)) || null,
        birth_date: birth,
        date,
        age: year - by,
      });
    }
  }
  out.sort((a, b) => cmp(a.date, b.date) || cmp(a.branch, b.branch) || cmp(a.child, b.child));
  return { from, to, birthdays: out };
}

/**
 * Today's rota as the staff were TOLD it (each branch's last published
 * סידור; a branch with nothing published says so), and the classes below the
 * licence ratio that day — the same warning the shift board shows. Staff by
 * first name + initial; hours, class and area only.
 */
async function shifts(date) {
  const week = sundayOf(date);
  const [weeks, maps, closed] = await Promise.all([
    ShiftWeek.find({ week_start: week }, 'branch_id published published_at closed_days').lean(),
    nameMaps(),
    closedBranches(date),
  ]);
  const branches = await Branch.find({ is_active: true }, 'name staff_ratios').lean();
  const kids = await Child.aggregate([
    { $match: realChildren() },
    { $group: { _id: '$classroom_id', n: { $sum: 1 } } },
  ]);
  const enrolled = new Map(kids.map(k => [String(k._id), k.n]));
  const byBranch = new Map(weeks.map(w => [String(w.branch_id), w]));
  const out = [];
  const gaps = [];
  const unpublished = [];
  for (const b of branches) {
    const id = String(b._id);
    const w = byBranch.get(id);
    const shut = closed.has('*') || closed.has(id) || (w?.closed_days || []).includes(date);
    if (shut) continue;
    if (!w || !w.published_at) { unpublished.push(b.name); continue; }
    const entries = (w.published || []).filter(e => e.date === date);
    for (const e of entries) {
      out.push({
        branch: b.name,
        class: e.area === 'class' ? (maps.classroomById.get(String(e.classroom_id))?.name || NO_CLASS) : null,
        area: e.area,
        staff: shortName(e.employee_name),
        from: e.start_hhmm || null,
        to: e.end_hhmm || null,
      });
    }
    const ratios = effectiveRatios(b);
    for (const room of [...maps.classroomById.values()].filter(c => String(c.branch_id) === id)) {
      const key = CATEGORY_KEY[room.category];
      const n = enrolled.get(String(room._id)) || 0;
      if (!key || !n) continue;
      const staff = new Set(entries.filter(e => e.area === 'class' && String(e.classroom_id) === String(room._id)).map(e => String(e.employee_id))).size;
      const needed = Math.ceil(n / ratios[key]);
      if (staff < needed) gaps.push({ branch: b.name, class: room.name, enrolled: n, staff, needed });
    }
  }
  out.sort((a, b) => cmp(a.branch, b.branch) || cmp(a.from, b.from) || cmp(a.class, b.class) || cmp(a.staff, b.staff));
  gaps.sort((a, b) => cmp(a.branch, b.branch) || cmp(a.class, b.class));
  return { date, shifts: out, gaps, unpublished_branches: unpublished.sort(cmp) };
}

/**
 * Parents who opened the portal (an activated account) in the last `days`
 * days — counted per branch through their children, first names only. An
 * account is a person: siblings are one parent, as on the signups screen.
 */
async function signups(days, now = new Date()) {
  const since = new Date(now.getTime() - days * DAY_MS);
  const [accounts, maps] = await Promise.all([
    ParentAccount.find({ activated: true, created_at: { $gte: since } }, 'id_number full_name').lean(),
    nameMaps(),
  ]);
  const ids = accounts.map(a => a.id_number).filter(Boolean);
  const kids = ids.length ? await Child.find(realChildren({ $or: [{ parent_id_number: { $in: ids } }, { parent2_id_number: { $in: ids } }] }), 'classroom_id parent_id_number parent2_id_number').lean() : [];
  const branchOf = new Map();
  for (const k of kids) {
    const b = maps.branchName.get(String(maps.classroomById.get(String(k.classroom_id))?.branch_id)) || null;
    for (const id of [k.parent_id_number, k.parent2_id_number]) if (id && !branchOf.has(id)) branchOf.set(id, b);
  }
  // only parents of a real, active child count — a test family or an account with no child here is not a signup
  const counted = accounts.filter(a => branchOf.has(a.id_number));
  const tally = new Map();
  for (const a of counted) { const b = branchOf.get(a.id_number); tally.set(b, (tally.get(b) || 0) + 1); }
  return {
    days,
    count: counted.length,
    by_branch: [...tally].map(([branch, count]) => ({ branch, count })).sort((x, y) => cmp(x.branch, y.branch)),
    parents: counted.map(a => ({ first_name: firstName(a.full_name), branch: branchOf.get(a.id_number) })).sort((x, y) => cmp(x.branch, y.branch) || cmp(x.first_name, y.first_name)),
  };
}

module.exports = {
  sync, parseMonth, currentMonthKey, monthState, duePassed, DUE_DAY, shortName, summary, payments, unpaid, children,
  parseDate, todayKey, attendance, pendingOrders, birthdays, shifts, signups,
};
