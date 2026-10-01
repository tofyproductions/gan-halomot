/**
 * Kaplan income writes — every one is a person's click, none is called from a
 * scan or a job. Spec §1 (2026-10-01-income-design).
 *
 * The only collections written here are IncomeAllocation, IncomeRejection and
 * IncomePayerAlias. Collection / Registration are never touched: the sheet
 * sync and the office's receipts own them (spec "הכרעה מרכזית").
 *
 * Writes to one transfer serialise on the lock `itx:<transactionId>` (the same
 * in-process mutex the expense writes use). Errors are `Error` with a Hebrew
 * message and `status`.
 */
const mongoose = require('mongoose');
const {
  BankAccount, BankTransaction, IncomeAllocation, IncomeRejection, IncomePayerAlias, Registration, User,
} = require('../models');
const { withLocks, atomically } = require('./expenseWrites.service');
const { COVERAGE_TOLERANCE_ILS, vendorKey } = require('./expenseCore.service');
const { ACADEMIC_MONTHS, CAMP_MONTH } = require('./academic-year.service');
const K = require('./incomeKaplan.service');

const TOLERANCE_ILS = 2;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const fail = (status, message) => Object.assign(new Error(message), { status });
const oid = (v, what) => {
  if (!mongoose.isValidObjectId(v)) throw fail(400, `${what} לא תקין`);
  return String(v);
};
const lockKey = (txId) => `itx:${txId}`;

/** An incoming bank-account line — the only thing that can be income. */
async function loadTransaction(txId) {
  oid(txId, 'מזהה תנועה');
  const tx = await BankTransaction.findById(txId).lean();
  if (!tx) throw fail(404, 'התנועה לא נמצאה');
  const account = await BankAccount.findById(tx.account_id, 'type').lean();
  if (!(tx.amount > 0) || tx.is_internal_transfer || !account || account.type !== 'bank') {
    throw fail(400, 'התנועה אינה העברה נכנסת לחשבון הבנק');
  }
  // Only what the pool offers can be allocated: from the start date, completed,
  // and not one an active income rule has claimed (Emunah, interest, refunds).
  const pool = await K.incomePool();
  if (!pool.open.some(t => String(t._id) === String(tx._id))) {
    throw fail(409, 'ההעברה אינה פתוחה לשיוך (לפני תאריך ההתחלה, לא הושלמה, מכוסה בכלל הכנסה, או כבר שויכה במלואה)');
  }
  return tx;
}

async function allocatedTotal(txId) {
  const [row] = await IncomeAllocation.aggregate([
    { $match: { transaction_id: new mongoose.Types.ObjectId(String(txId)) } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  return round2(row ? row.total : 0);
}

/** Bank words that say nothing about who paid — an alias on them would swallow every transfer. */
const GENERIC_PAYER_WORDS = ['העברה', 'העברה בנקאית', 'הפקדה', 'זיכוי', 'מזומן', 'שיק', 'צק', 'ביט', 'פייבוקס', 'bit', 'paybox'];
const GENERIC_TOKENS = new Set(GENERIC_PAYER_WORDS.flatMap(w => vendorKey(w).split(' ')));
const MIN_PAYER_KEY_LENGTH = 4;

function isRememberablePayer(payer) {
  if (!payer || payer.length < MIN_PAYER_KEY_LENGTH) return false;
  return payer.split(' ').some(t => !GENERIC_TOKENS.has(t));
}

/**
 * Remember who paid. The first confirmed mapping wins: a payer text already
 * pointing at another family is kept and reported as a conflict (the office
 * can clear it). Returns 'created' | 'same' | 'conflict' | 'skipped'.
 * Runs inside the accept's scope, so a rolled-back accept leaves no alias.
 */
async function rememberPayer(payer, household, by, txId, { session, undo }) {
  if (!isRememberablePayer(payer)) return 'skipped';
  const opts = session ? { session } : {};
  const existing = await IncomePayerAlias.findOne({ payer_key: payer }, null, opts).lean();
  if (existing) return K.householdMatchesKey(household, existing.household_key) ? 'same' : 'conflict';
  try {
    const [made] = await IncomePayerAlias.create([{
      payer_key: payer, household_key: household.household_key, source_transaction_id: txId, created_by: by || null,
    }], opts);
    undo(() => IncomePayerAlias.deleteOne({ _id: made._id }));
    return 'created';
  } catch (e) {
    if (!(e && e.code === 11000)) throw e;
    const now = await IncomePayerAlias.findOne({ payer_key: payer }).lean();
    return now && K.householdMatchesKey(household, now.household_key) ? 'same' : 'conflict';
  }
}

/**
 * Attribute (part of) a transfer to a family's children and months.
 * Σ allocations of the transfer stays ≤ amount + 2 ₪. Without `split` the
 * earliest open months across the family's children are used.
 */
async function acceptIncome({ transaction_id, household_key, split, academic_year, by = null }) {
  oid(transaction_id, 'מזהה תנועה');
  if (!household_key) throw fail(400, 'חסרה משפחה');
  return withLocks([lockKey(transaction_id)], async () => {
    const tx = await loadTransaction(transaction_id);
    if (academic_year != null && !/^(\d{4})-(\d{4})$/.test(academic_year)) throw fail(400, 'שנת לימודים לא תקינה');
    if (academic_year != null && Number(academic_year.slice(5)) !== Number(academic_year.slice(0, 4)) + 1) throw fail(400, 'שנת לימודים לא תקינה');
    // A payment can belong to another gan year than its date (paid ahead / in arrears).
    const year = academic_year || K.academicYearOfDate(tx.date);
    if (!year) throw fail(400, 'לתנועה אין תאריך תקין');
    const households = await K.kaplanHouseholds(year);
    const household = households.find(h => K.householdMatchesKey(h, household_key));
    if (!household) throw fail(404, 'המשפחה לא נמצאה בשנת הלימודים של ההעברה');

    const remaining = round2(tx.amount - await allocatedTotal(tx._id));
    if (remaining <= COVERAGE_TOLERANCE_ILS) throw fail(409, 'ההעברה כבר הוקצתה במלואה');

    const seen = new Set();
    let slices;
    if (Array.isArray(split) && split.length) {
      slices = split.map((s) => {
        const child = household.children.find(c => String(c.registration_id) === String(s.registration_id));
        if (!child) throw fail(400, 'הילד אינו שייך למשפחה שנבחרה');
        const month = Number(s.month_number);
        if (!(ACADEMIC_MONTHS.includes(month) || month === CAMP_MONTH) || !child.months.some(m => m.month_number === month)) {
          throw fail(400, 'חודש לא תקין לילד');
        }
        const amount = round2(s.amount);
        if (!(amount > 0)) throw fail(400, 'סכום ההקצאה חייב להיות חיובי');
        const dupKey = `${child.registration_id}|${month}`;
        if (seen.has(dupKey)) throw fail(400, 'אותו ילד וחודש מופיעים פעמיים בפיצול');
        seen.add(dupKey);
        const cell = child.months.find(m => m.month_number === month);
        if (amount > round2(cell.expected - cell.allocated) + TOLERANCE_ILS) throw fail(400, 'סכום ההקצאה גדול מהסכום הפתוח בחודש');
        return { registration_id: child.registration_id, month_number: month, amount };
      });
    } else {
      slices = K.splitInto(K.ledgerOf(household), remaining)
        .map(({ registration_id, month_number, amount }) => ({ registration_id, month_number, amount }));
      if (!slices.length) throw fail(409, 'אין חודשים פתוחים לשיוך');
    }
    const sum = round2(slices.reduce((s, x) => s + x.amount, 0));
    if (sum > remaining + TOLERANCE_ILS) throw fail(400, 'סכום ההקצאות גדול מיתרת ההעברה');

    let alias = 'skipped';
    const allocations = await atomically(async ({ session, undo }) => {
      const docs = slices.map(s => ({
        transaction_id: tx._id,
        registration_id: s.registration_id,
        household_key: household.household_key,
        academic_year: year,
        month_number: s.month_number,
        amount: s.amount,
        created_by: by || null,
      }));
      const created = await IncomeAllocation.insertMany(docs, session ? { session } : {});
      undo(() => IncomeAllocation.deleteMany({ _id: { $in: created.map(c => c._id) } }));
      alias = await rememberPayer(K.payerKey(tx), household, by, tx._id, { session, undo });
      // Accepting a family overrides an earlier "not this one" for it.
      const keys = [household.household_key, ...(household.member_keys || [])];
      const rej = await IncomeRejection.find({ transaction_id: tx._id, household_key: { $in: keys } }, null, session ? { session } : {}).lean();
      if (rej.length) {
        await IncomeRejection.deleteMany({ _id: { $in: rej.map(r => r._id) } }, session ? { session } : {});
        undo(() => IncomeRejection.insertMany(rej.map(({ _id, ...r }) => r)));
      }
      return created.map(c => c.toObject());
    }, { transaction_id: String(tx._id) });
    return { allocations, alias };
  });
}

/** "✗ לא זה" — rule a family out for a transfer. Idempotent. */
async function rejectIncome({ transaction_id, household_key }) {
  oid(transaction_id, 'מזהה תנועה');
  if (!household_key) throw fail(400, 'חסרה משפחה');
  return withLocks([lockKey(transaction_id)], async () => {
    await loadTransaction(transaction_id);
    await IncomeRejection.updateOne(
      { transaction_id, household_key },
      { $setOnInsert: { transaction_id, household_key } },
      { upsert: true },
    );
    return { ok: true };
  });
}

/** Take all of a transfer's allocations back; the transfer returns to the open pool. Idempotent. */
async function unallocate(transaction_id) {
  oid(transaction_id, 'מזהה תנועה');
  return withLocks([lockKey(transaction_id)], async () => {
    const r = await IncomeAllocation.deleteMany({ transaction_id });
    // Only an alias this very transfer created goes with it.
    await IncomePayerAlias.deleteMany({ source_transaction_id: transaction_id });
    return { removed: r.deletedCount || 0 };
  });
}

/**
 * Per gan month: expected (collections screen), paid by receipt (receipt
 * number or status paid, sibling receipts included), found in the bank
 * (allocations) — plus the two cross-check lists, per child and month.
 */
async function kaplanMonthReport(academicYear) {
  const households = await K.kaplanHouseholds(academicYear);
  const byMonth = new Map([...ACADEMIC_MONTHS, CAMP_MONTH].map(m => [m, { month_number: m, expected: 0, by_receipt: 0, in_bank: 0 }]));
  const receipt_no_bank = [];
  const bank_no_receipt = [];
  for (const h of households) {
    for (const c of h.children) {
      for (const m of c.months) {
        const row = byMonth.get(m.month_number);
        if (!row) continue;
        const hasReceipt = !!m.receipt || !!m.paid;
        row.expected = round2(row.expected + m.expected);
        row.in_bank = round2(row.in_bank + m.allocated);
        if (hasReceipt) row.by_receipt = round2(row.by_receipt + m.expected);
        const base = {
          household_key: h.household_key, registration_id: c.registration_id, child_name: c.child_name,
          month_number: m.month_number, expected: m.expected, allocated: m.allocated, receipt: m.receipt || null,
        };
        if (hasReceipt && m.expected > 0 && m.allocated + TOLERANCE_ILS < m.expected) receipt_no_bank.push(base);
        if (!hasReceipt && m.allocated > 0) bank_no_receipt.push(base);
      }
    }
  }
  const months = [...byMonth.values()].filter(r => r.month_number !== CAMP_MONTH || r.expected || r.in_bank);
  return { academic_year: academicYear, months, receipt_no_bank, bank_no_receipt };
}

/**
 * Transfers with allocations in a gan year, newest allocation first — what
 * "בטל שיוך" lists. Per transfer: the bank line, the family's parents, every
 * child+month slice, who matched it and when. Read only.
 */
async function matchedTransfers(academicYear) {
  const inYear = await IncomeAllocation.find({ academic_year: academicYear }).sort({ created_at: -1, _id: -1 }).lean();
  if (!inYear.length) return [];
  const txIds = [...new Set(inYear.map(a => String(a.transaction_id)))];
  // "בטל שיוך" removes every slice of the transfer, in every year and family,
  // so every slice is returned — never only the ones of the requested year.
  const everySlice = await IncomeAllocation.find({ transaction_id: { $in: txIds } }).sort({ created_at: -1, _id: -1 }).lean();
  const bySlices = new Map();
  for (const a of everySlice) {
    const k = String(a.transaction_id);
    if (!bySlices.has(k)) bySlices.set(k, []);
    bySlices.get(k).push(a);
  }
  const regIds = [...new Set(everySlice.map(a => String(a.registration_id)))];
  const userIds = [...new Set(everySlice.map(a => a.created_by && String(a.created_by)).filter(Boolean))];
  const years = [...new Set(everySlice.map(a => a.academic_year))];
  const [txs, regs, users, householdLists] = await Promise.all([
    BankTransaction.find({ _id: { $in: txIds } }, 'date amount description counterparty').lean(),
    Registration.find({ _id: { $in: regIds } }, 'child_name').lean(),
    userIds.length ? User.find({ _id: { $in: userIds } }, 'full_name').lean() : [],
    Promise.all(years.map(y => K.kaplanHouseholds(y))),
  ]);
  const txById = new Map(txs.map(t => [String(t._id), t]));
  const childName = new Map(regs.map(r => [String(r._id), r.child_name]));
  const userName = new Map(users.map(u => [String(u._id), u.full_name]));
  const householdsByYear = new Map(years.map((y, i) => [y, householdLists[i]]));
  const parentsOf = (a) => {
    const h = (householdsByYear.get(a.academic_year) || []).find(x => K.householdMatchesKey(x, a.household_key));
    return h ? h.parents : [];
  };

  // Ordered by the newest slice in the requested year, as before.
  const out = [];
  for (const k of txIds) {
    const slices = bySlices.get(k);
    const first = slices[0];
    const t = txById.get(k) || {};
    out.push({
      transaction_id: first.transaction_id,
      tx: { date: t.date || null, amount: t.amount ?? null, description: t.description || '', counterparty: t.counterparty || '' },
      household_key: first.household_key,
      parents: parentsOf(first),
      allocations: slices.map(a => ({
        registration_id: a.registration_id, child_name: childName.get(String(a.registration_id)) || '',
        academic_year: a.academic_year, household_key: a.household_key, parents: parentsOf(a),
        month_number: a.month_number, amount: a.amount,
      })),
      total: round2(slices.reduce((n, a) => n + a.amount, 0)),
      created_by: first.created_by || null,
      created_by_name: first.created_by ? userName.get(String(first.created_by)) || null : null,
      created_at: first.created_at,
    });
  }
  return out;
}

module.exports = { acceptIncome, rejectIncome, unallocate, kaplanMonthReport, matchedTransfers };
